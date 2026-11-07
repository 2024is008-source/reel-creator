"""Google Flow / Nano Banana Browser Automation Runner.

Adapted from `google-flow-browser-mcp` (`generate-image.js`, `project-navigator.js`, `safe-actions.js`):
1. Ensures automation runs inside a Google Flow project context (`/project/{uuid}`) via `FlowProjectNavigator`,
   reusing existing projects by campaign/project_id or creating a new project.
2. Switches the bottom toolbar to Image mode (`switch_to_image_mode`) and verifies that no paid video
   model (`Omni Flash`, `Veo`) is active before clicking Generate.
3. Fills the prompt in the bottom toolbar (`[contenteditable="true"]:visible` or `textarea:visible`)
   using safe clear + delayed typing.
4. Clicks the Generate button (`arrow_forward` / `Créer` / `Generate`) and handles Google Flow's
   Agent confirmation dialog (`Accepter` / `Approve`) if presented.
5. Detects generated image UUIDs via `media.getMediaUrlRedirect?name=([a-f0-9-]+)` and downloads
   high-resolution images over the authenticated browser session without leaving the project page
   (with fallback to blob/data/http image sources).
"""
from __future__ import annotations

import base64
import re
import time
import urllib.request
from typing import Any, Literal

from .browser_manager import BrowserManager
from .image_download import ImageDownloadManager, SceneImageRecord
from datetime import datetime, timezone
from pathlib import Path
import json
from .prompts import build_nano_banana_scene_prompt


class FlowProjectNavigator:
    """Manages Google Flow project creation, campaign reuse, sidebar navigation, and Image mode switching."""

    def __init__(self, config_dir: Path | None = None, flow_url: str = "https://labs.google/fx/tools/flow") -> None:
        base_dir = Path(__file__).resolve().parent
        self.config_dir = (config_dir or (base_dir / "config")).resolve()
        self.config_dir.mkdir(parents=True, exist_ok=True)
        self.projects_file = self.config_dir / "flow.projects.json"
        self.selectors_file = self.config_dir / "selectors.map.json"
        self.flow_url = flow_url

    def load_projects(self) -> dict[str, Any]:
        if self.projects_file.exists():
            try:
                return json.loads(self.projects_file.read_text(encoding="utf-8"))
            except Exception:
                pass
        return {"projects": []}

    def save_projects(self, data: dict[str, Any]) -> None:
        self.config_dir.mkdir(parents=True, exist_ok=True)
        self.projects_file.write_text(json.dumps(data, indent=2), encoding="utf-8")

    def list_existing_projects(self, page: Any) -> list[dict[str, Any]]:
        """Scans the Google Flow homepage for existing project cards."""
        current_url = page.url or ""
        if self.flow_url not in current_url or "/project/" in current_url:
            page.goto(self.flow_url, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(2000)

        try:
            projects = page.evaluate(
                """() => {
                    const result = [];
                    const allCards = document.querySelectorAll(
                        '[class*="card"], [class*="project"], li, article, [class*="grid"] > div, a[href*="/project/"]'
                    );
                    allCards.forEach(card => {
                        const text = (card.textContent || '').trim();
                        const href = card.getAttribute('href') || (card.querySelector('a[href*="/project/"]')?.getAttribute('href')) || '';
                        const hasEditDelete = text.includes('Modifier') || text.includes('Supprimer') ||
                                              text.includes('Edit') || text.includes('Delete') ||
                                              href.includes('/project/');
                        if (hasEditDelete && text.length > 2 && text.length < 500) {
                            const lines = text.split('\\n').map(s => s.trim()).filter(Boolean);
                            const nameLines = lines.filter(l =>
                                !l.includes('Modifier') && !l.includes('Supprimer') &&
                                !l.includes('edit') && !l.includes('delete') &&
                                !l.includes('Edit') && !l.includes('Delete') &&
                                l.length > 1
                            );
                            result.push({
                                name: nameLines.join(' | ') || 'Untitled Project',
                                url: href ? (href.startsWith('http') ? href : 'https://labs.google' + href) : null,
                                fullText: text.substring(0, 300),
                            });
                        }
                    });
                    return result;
                }"""
            )
            return projects if isinstance(projects, list) else []
        except Exception:
            return []

    def create_new_project(self, page: Any, name: str | None = None, campaign: str | None = None) -> dict[str, Any]:
        """Clicks 'New project' / 'Nouveau projet', names it if prompted, enters `/project/{uuid}`, and registers it."""
        current_url = page.url or ""
        if "/project/" in current_url or "labs.google" not in current_url:
            page.goto(self.flow_url, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(2000)

        new_btn_selectors = [
            'button:has-text("Nouveau projet")',
            'a:has-text("Nouveau projet")',
            '[aria-label*="Nouveau projet"]',
            'button:has-text("New project")',
            'a:has-text("New project")',
            '[aria-label*="New project"]',
            'button:has-text("Create project")',
            'button:has-text("Start creating")',
            'button:has-text("Create with Flow")',
            'button:has-text("add_2")',
        ]

        clicked = False
        for sel in new_btn_selectors:
            try:
                btn = page.locator(sel).first
                if btn.count() > 0 and btn.is_visible():
                    btn.click(timeout=5000)
                    clicked = True
                    break
            except Exception:
                continue

        if not clicked:
            for label in ("Nouveau projet", "New project", "Create project", "Start creating", "Create with Flow"):
                try:
                    for role in ("button", "link"):
                        loc = page.get_by_role(role, name=label, exact=False)
                        if loc.count() > 0 and loc.first.is_visible():
                            loc.first.click(timeout=5000)
                            clicked = True
                            break
                    if clicked:
                        break
                except Exception:
                    continue

        if not clicked:
            try:
                fallback = page.locator('[aria-label*="add" i], button:has-text("add"), [class*="fab"]').first
                if fallback.count() > 0 and fallback.is_visible():
                    fallback.click(timeout=5000)
                    clicked = True
            except Exception:
                pass

        if clicked:
            page.wait_for_timeout(3500)

        # If Flow prompts for a project name dialog, fill it
        name_input_selectors = [
            'input[placeholder*="Nom"]',
            'input[placeholder*="nom"]',
            'input[placeholder*="name"]',
            'input[placeholder*="Name"]',
        ]
        project_name = name or f"Project {datetime.now().strftime('%Y-%m-%d %H:%M')}"
        for sel in name_input_selectors:
            try:
                inp = page.locator(sel).first
                if inp.count() > 0 and inp.is_visible():
                    inp.click(timeout=3000)
                    inp.fill(project_name, timeout=3000)
                    page.wait_for_timeout(400)
                    for csel in (
                        'button:has-text("Créer")',
                        'button:has-text("Confirmer")',
                        'button:has-text("OK")',
                        'button:has-text("Create")',
                        '[type="submit"]',
                    ):
                        try:
                            cbtn = page.locator(csel).first
                            if cbtn.count() > 0 and cbtn.is_visible():
                                cbtn.click(timeout=3000)
                                page.wait_for_timeout(2000)
                                break
                        except Exception:
                            continue
                    break
            except Exception:
                continue

        final_url = page.url or ""

        # If still not inside `/project/{uuid}`, navigate into the first project card link
        if "/project/" not in final_url:
            page.wait_for_timeout(1500)
            try:
                card_href = page.evaluate(
                    """() => {
                        const links = document.querySelectorAll('a[href*="/project/"]');
                        if (links.length > 0) {
                            const href = links[0].getAttribute('href');
                            if (href) {
                                return href.startsWith('http') ? href : 'https://labs.google' + href;
                            }
                        }
                        return null;
                    }"""
                )
                if card_href:
                    page.goto(card_href, wait_until="domcontentloaded", timeout=30000)
                    page.wait_for_timeout(2500)
                    final_url = page.url or card_href
                else:
                    plink = page.locator('a[href*="/project/"]').first
                    if plink.count() > 0 and plink.is_visible():
                        plink.click(timeout=5000)
                        page.wait_for_timeout(2500)
                        final_url = page.url or ""
            except Exception:
                pass

        store = self.load_projects()
        now_iso = datetime.now(timezone.utc).isoformat()
        entry = {
            "id": f"proj_{int(time.time() * 1000)}",
            "url": final_url,
            "name": project_name,
            "campaign": campaign or project_name,
            "created_at": now_iso,
            "last_used": now_iso,
            "tasks": [],
        }
        store.setdefault("projects", []).append(entry)
        self.save_projects(store)
        return {"url": final_url, "reused": False, "id": entry["id"], "name": entry["name"]}

    def ensure_project_in_context(
        self,
        page: Any,
        name: str | None = None,
        campaign: str | None = None,
        force_new: bool = False,
    ) -> dict[str, Any]:
        """Ensures the browser is inside a Google Flow project (`/project/{uuid}`).

        1. If already in a `/project/` URL and not forcing new -> reuse current project.
        2. If `campaign` matches a stored project URL -> navigate to and reuse that project.
        3. Otherwise -> create or open a project on the Flow dashboard.
        """
        current_url = page.url or ""
        if "/project/" in current_url and not force_new:
            return {"url": current_url, "reused": True, "name": name or "Active Flow Project"}

        if not force_new and campaign:
            store = self.load_projects()
            for proj in reversed(store.get("projects", [])):
                proj_camp = (proj.get("campaign") or "").lower()
                proj_url = proj.get("url") or ""
                if proj_camp == campaign.lower() and "/project/" in proj_url:
                    try:
                        page.goto(proj_url, wait_until="domcontentloaded", timeout=30000)
                        page.wait_for_timeout(2000)
                        if "/project/" in (page.url or ""):
                            proj["last_used"] = datetime.now(timezone.utc).isoformat()
                            self.save_projects(store)
                            return {
                                "url": page.url,
                                "reused": True,
                                "id": proj.get("id"),
                                "name": proj.get("name"),
                            }
                    except Exception:
                        continue

        return self.create_new_project(page, name=name, campaign=campaign)

    def switch_to_image_mode(self, page: Any) -> bool:
        """Switches the project's bottom toolbar from Video mode to Image mode.

        Handles both:
        1. Role tab `button[role="tab"][id*="trigger-IMAGE"]`
        2. Video/Image dropdown menu (`[role="menuitem"]:has-text("Image")`)
        3. Accessible Image tab/button fallback
        """
        try:
            current_img_tab = page.evaluate(
                """() => {
                    const imageTab = document.querySelector('button[role="tab"][id*="trigger-IMAGE"]');
                    if (imageTab) return imageTab.getAttribute('aria-selected');
                    return null;
                }"""
            )
            if current_img_tab == "true":
                return True
        except Exception:
            pass

        # 1. Try clicking the explicit trigger-IMAGE tab
        try:
            img_tab = page.locator('button[role="tab"][id*="trigger-IMAGE"]').first
            if img_tab.count() > 0 and img_tab.is_visible():
                is_disabled = img_tab.get_attribute("aria-disabled")
                if is_disabled != "true":
                    img_tab.click(timeout=3000)
                    page.wait_for_timeout(1200)
                    verify = page.evaluate(
                        """() => {
                            const tab = document.querySelector('button[role="tab"][id*="trigger-IMAGE"]');
                            return tab ? tab.getAttribute('aria-selected') : null;
                        }"""
                    )
                    if verify == "true":
                        return True
                    # Retry click once
                    img_tab.click(timeout=3000)
                    page.wait_for_timeout(1200)
                    verify2 = page.evaluate(
                        """() => {
                            const tab = document.querySelector('button[role="tab"][id*="trigger-IMAGE"]');
                            return tab ? tab.getAttribute('aria-selected') : null;
                        }"""
                    )
                    if verify2 == "true":
                        return True
        except Exception:
            pass

        # 2. Try the Video dropdown fallback ("Vidéo" / "Video" button -> "Image" menuitem)
        for v_label in ("Vidéo", "Video"):
            try:
                v_btn = page.locator(f'button:has-text("{v_label}")').first
                if v_btn.count() > 0 and v_btn.is_visible():
                    v_btn.click(timeout=3000)
                    page.wait_for_timeout(1000)
                    img_opt = page.locator(
                        '[role="menuitem"]:has-text("Image"), [role="option"]:has-text("Image"), [id*="trigger-IMAGE"]'
                    ).first
                    if img_opt.count() > 0 and img_opt.is_visible():
                        img_opt.click(timeout=3000)
                        page.wait_for_timeout(1000)
                        page.keyboard.press("Escape")
                        return True
                    page.keyboard.press("Escape")
            except Exception:
                pass

        # 3. Try standard button/tab with name "Image"
        for role in ("tab", "button"):
            try:
                btn = page.get_by_role(role, name="Image", exact=False)
                if btn.count() > 0 and btn.first.is_visible():
                    btn.first.click(timeout=2000)
                    page.wait_for_timeout(600)
                    return True
            except Exception:
                continue

        return False

    def verify_not_video_model(self, page: Any) -> tuple[bool, str | None]:
        """Checks the bottom toolbar model pill to ensure an expensive video model (Veo / Omni Flash)
        is not accidentally active when generating images. If a video model is active, attempts to
        switch to Nano Banana 2 / Nano Banana Pro / Imagen 4 first.
        """
        try:
            model_from_ui: str | None = page.evaluate(
                """() => {
                    const modelBtn = Array.from(document.querySelectorAll('button'))
                        .find(b => {
                            const text = b.textContent || '';
                            return (text.includes('Nano') || text.includes('Banana') ||
                                    text.includes('Omni') || text.includes('Veo') ||
                                    text.includes('Imagen')) && b.offsetParent !== null;
                        });
                    return modelBtn ? modelBtn.textContent.trim().replace(/\\s+/g, ' ').substring(0, 80) : null;
                }"""
            )
        except Exception:
            model_from_ui = None

        if not model_from_ui:
            return True, None

        video_keywords = ("Omni Flash", "Veo", "Omni")
        if any(vk.lower() in model_from_ui.lower() for vk in video_keywords):
            switched = self.select_image_model(page, preferred_model="Nano Banana 2")
            if switched:
                return True, "Nano Banana 2"
            return False, model_from_ui

        return True, model_from_ui

    def select_image_model(self, page: Any, preferred_model: str = "Nano Banana 2") -> bool:
        """Selects an image model (Nano Banana 2, Nano Banana Pro, Nano Banana, Imagen 4) in Flow's toolbar."""
        candidates = [preferred_model, "Nano Banana 2", "Nano Banana Pro", "Nano Banana", "Imagen 4", "Imagen"]
        try:
            model_trigger = page.locator(
                'button:has-text("Nano"), button:has-text("Banana"), button:has-text("Imagen"), '
                'button:has-text("Omni"), button:has-text("Veo")'
            ).first
            if model_trigger.count() > 0 and model_trigger.is_visible():
                txt = (model_trigger.inner_text() or "").strip()
                if any(k in txt for k in ("Nano", "Banana", "Imagen")) and not any(
                    vk in txt for vk in ("Omni", "Veo")
                ):
                    return True
                model_trigger.click(timeout=2500)
                page.wait_for_timeout(600)
                for cand in candidates:
                    opt = page.locator(
                        f'[role="menuitem"]:has-text("{cand}"), [role="option"]:has-text("{cand}"), text="{cand}"'
                    ).first
                    if opt.count() > 0 and opt.is_visible():
                        opt.click(timeout=2500)
                        page.wait_for_timeout(600)
                        return True
                page.keyboard.press("Escape")
        except Exception:
            pass

        for label in candidates:
            try:
                btn = page.get_by_role("button", name=label, exact=False)
                if btn.count() > 0 and btn.first.is_visible():
                    btn.first.click(timeout=1500)
                    return True
            except Exception:
                continue
        return False

    def select_aspect_ratio(self, page: Any, ratio: str = "9:16") -> bool:
        """Selects the requested aspect ratio (9:16 vertical default or 16:9 widescreen) in the Flow toolbar."""
        if ratio == "16:9":
            labels = ["16:9", "Landscape", "Horizontal", "Paysage", "Widescreen"]
            opposite = ["9:16", "Portrait", "Vertical", "1:1", "4:3", "3:4"]
        else:
            labels = [ratio, "9:16", "Portrait", "Vertical"]
            opposite = ["16:9", "Landscape", "Horizontal", "Paysage", "1:1", "4:3", "3:4"]

        # First check if a ratio dropdown pill is currently showing another ratio (e.g. 16:9 when we want 9:16)
        try:
            for opp in opposite:
                opp_btn = page.locator(f'button:has-text("{opp}")').first
                if opp_btn.count() > 0 and opp_btn.is_visible():
                    opp_btn.click(timeout=2000)
                    page.wait_for_timeout(500)
                    for target_lbl in labels:
                        opt = page.locator(
                            f'[role="menuitem"]:has-text("{target_lbl}"), [role="option"]:has-text("{target_lbl}"), button:has-text("{target_lbl}")'
                        ).first
                        if opt.count() > 0 and opt.is_visible():
                            opt.click(timeout=2000)
                            page.wait_for_timeout(400)
                            return True
                    page.keyboard.press("Escape")
        except Exception:
            pass

        for ratio_label in labels:
            try:
                rbtn = page.locator(f'button:has-text("{ratio_label}"), [aria-label*="{ratio_label}"]').first
                if rbtn.count() > 0 and rbtn.is_visible():
                    rbtn.click(timeout=1500)
                    page.wait_for_timeout(400)
                    opt = page.locator(
                        f'[role="menuitem"]:has-text("{ratio_label}"), [role="option"]:has-text("{ratio_label}")'
                    ).first
                    if opt.count() > 0 and opt.is_visible():
                        opt.click(timeout=1500)
                        page.wait_for_timeout(300)
                    return True
            except Exception:
                pass
            try:
                rbtn2 = page.get_by_role("button", name=ratio_label, exact=False)
                if rbtn2.count() > 0 and rbtn2.first.is_visible():
                    rbtn2.first.click(timeout=1500)
                    return True
            except Exception:
                pass
        return False

    def navigate_to_sidebar(self, page: Any, section: str) -> bool:
        """Navigates to a section in the current project's sidebar (e.g., Personnages/Characters, Scènes/Scenes, Outils/Tools)."""
        selectors = [
            f'[class*="sidebar"] button:has-text("{section}")',
            f'[class*="sidebar"] a:has-text("{section}")',
            f'nav button:has-text("{section}")',
            f'nav a:has-text("{section}")',
            f'[class*="nav"] button:has-text("{section}")',
            f'[class*="nav"] a:has-text("{section}")',
            f'button:has-text("{section}")',
            f'a:has-text("{section}")',
        ]
        for selector in selectors:
            try:
                el = page.locator(selector).first
                if el.count() > 0 and el.is_visible():
                    el.click(timeout=3000)
                    page.wait_for_timeout(1500)
                    return True
            except Exception:
                continue
        return False

    def register_task_in_project(self, project_id: str | None, task_info: dict[str, Any]) -> None:
        if not project_id:
            return
        store = self.load_projects()
        for proj in store.get("projects", []):
            if proj.get("id") == project_id or proj.get("campaign") == project_id:
                now_iso = datetime.now(timezone.utc).isoformat()
                proj.setdefault("tasks", []).append({**task_info, "timestamp": now_iso})
                proj["last_used"] = now_iso
                self.save_projects(store)
                break

    def discover_ui(self, page: Any, page_name: str = "main") -> dict[str, Any]:
        """Discovers interactive buttons, inputs, headings, models, and ratios on the current Google Flow page
        and updates `selectors.map.json` (adapted from `discover-ui.js`).
        """
        current_url = page.url or ""
        title = ""
        try:
            title = page.title() or ""
        except Exception:
            pass

        try:
            elements = page.evaluate(
                """() => {
                    const result = {
                        buttons: [],
                        inputs: [],
                        links: [],
                        headings: [],
                        visibleModels: [],
                        visibleRatios: [],
                    };
                    document.querySelectorAll('button, [role="button"], [type="button"]').forEach(el => {
                        const text = (el.textContent || el.getAttribute('aria-label') || '').trim();
                        if (text && text.length < 100) {
                            result.buttons.push({
                                text: text.substring(0, 80),
                                visible: !!el.offsetParent,
                                tag: el.tagName,
                                ariaLabel: el.getAttribute('aria-label') || null,
                                dataTestId: el.getAttribute('data-test-id') || el.getAttribute('data-testid') || null,
                            });
                        }
                    });
                    document.querySelectorAll('input:not([type="hidden"]), textarea, [contenteditable="true"]').forEach(el => {
                        result.inputs.push({
                            placeholder: (el.getAttribute('placeholder') || '').substring(0, 60),
                            ariaLabel: (el.getAttribute('aria-label') || '').substring(0, 60),
                            name: (el.getAttribute('name') || '').substring(0, 60),
                            type: el.getAttribute('type') || el.tagName,
                            visible: !!el.offsetParent,
                        });
                    });
                    document.querySelectorAll('a[href]').forEach(el => {
                        const text = (el.textContent || '').trim();
                        if (text && text.length < 80) {
                            result.links.push({
                                text: text.substring(0, 60),
                                href: (el.getAttribute('href') || '').substring(0, 100),
                                visible: !!el.offsetParent,
                            });
                        }
                    });
                    document.querySelectorAll('h1, h2, h3, h4').forEach(el => {
                        result.headings.push({
                            level: el.tagName,
                            text: (el.textContent || '').trim().substring(0, 80),
                        });
                    });
                    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
                    const texts = [];
                    while (walker.nextNode()) {
                        const t = (walker.currentNode.textContent || '').trim();
                        if (t && t.length > 2 && t.length < 120) texts.push(t);
                    }
                    const uniq = [...new Set(texts)];
                    result.visibleModels = uniq.filter(t =>
                        t.includes('Nano') || t.includes('Imagen') || t.includes('Veo') ||
                        t.includes('Omni') || t.includes('Model') || t.includes('Modèle')
                    );
                    result.visibleRatios = uniq.filter(t =>
                        t.includes(':') && (t.includes('9') || t.includes('4') || t.includes('3') || t.includes('1'))
                    );
                    return result;
                }"""
            )
        except Exception:
            elements = {
                "buttons": [],
                "inputs": [],
                "links": [],
                "headings": [],
                "visibleModels": [],
                "visibleRatios": [],
            }

        selectors_map: dict[str, Any] = {}
        if self.selectors_file.exists():
            try:
                selectors_map = json.loads(self.selectors_file.read_text(encoding="utf-8"))
            except Exception:
                selectors_map = {}

        now_iso = datetime.now(timezone.utc).isoformat()
        selectors_map["_lastUpdated"] = now_iso
        selectors_map[page_name] = {
            "url": current_url,
            "title": title,
            "discoveredAt": now_iso,
            "selectors": {
                "buttons": elements.get("buttons", []),
                "inputs": elements.get("inputs", []),
                "links": elements.get("links", []),
                "headings": elements.get("headings", []),
                "modelTexts": elements.get("visibleModels", []),
                "ratioTexts": elements.get("visibleRatios", []),
            },
        }
        try:
            self.selectors_file.write_text(json.dumps(selectors_map, indent=2), encoding="utf-8")
        except Exception:
            pass

        return {
            "status": "discovered",
            "page": page_name,
            "url": current_url,
            "title": title,
            "elements": {
                "buttons": [b.get("text") for b in elements.get("buttons", []) if b.get("text")],
                "inputs": [
                    i.get("placeholder") or i.get("ariaLabel") or i.get("name")
                    for i in elements.get("inputs", [])
                    if i.get("placeholder") or i.get("ariaLabel") or i.get("name")
                ],
                "headings": [f"{h.get('level')}: {h.get('text')}" for h in elements.get("headings", [])],
                "visible_models": elements.get("visibleModels", []),
                "visible_ratios": elements.get("visibleRatios", []),
            },
            "totalButtonsFound": len(elements.get("buttons", [])),
            "totalInputsFound": len(elements.get("inputs", [])),
        }


FlowErrorCode = Literal[
    "FLOW_BROWSER_DISCONNECTED",
    "FLOW_SIGNIN_REQUIRED",
    "FLOW_CAPTCHA_OR_VERIFICATION",
    "FLOW_UI_CHANGED",
    "FLOW_VIDEO_MODEL_BLOCKED",
    "FLOW_TIMEOUT",
    "FLOW_GENERATION_FAILED",
    "FLOW_DOWNLOAD_FAILED",
]

UUID_MEDIA_REGEX = re.compile(r"media\.getMediaUrlRedirect\?name=([a-f0-9-]+)", re.IGNORECASE)


class FlowAutomationError(Exception):
    def __init__(self, code: FlowErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class FlowAutomationRunner:
    """Executes single-scene image generation on Google Flow / Nano Banana via Playwright."""

    def __init__(
        self,
        browser_manager: BrowserManager,
        download_manager: ImageDownloadManager,
        project_navigator: FlowProjectNavigator | None = None,
        timeout_seconds: int = 120,
        max_retries: int = 3,
    ) -> None:
        self.browser_manager = browser_manager
        self.download_manager = download_manager
        self.project_navigator = project_navigator or FlowProjectNavigator(flow_url=browser_manager.flow_url)
        self.timeout_seconds = timeout_seconds
        self.max_retries = max_retries

    def generate_scene_image(
        self,
        project_id: str,
        scene_id: str,
        visual_description: str,
        image_prompt: str,
        visual_bible: dict[str, Any] | None = None,
        camera_movement: str = "slow zoom in",
        model: str = "Nano Banana 2",
        ratio: str = "9:16",
    ) -> SceneImageRecord:
        full_prompt = build_nano_banana_scene_prompt(
            visual_description=visual_description,
            image_prompt=image_prompt,
            visual_bible=visual_bible,
            camera_movement=camera_movement,
            aspect_ratio=ratio,
        )

        last_err: FlowAutomationError | None = None
        for attempt in range(1, self.max_retries + 1):
            try:
                return self._run_single_attempt(
                    project_id=project_id,
                    scene_id=scene_id,
                    full_prompt=full_prompt,
                    model=model,
                    ratio=ratio,
                )
            except FlowAutomationError as flow_err:
                last_err = flow_err
                # Never auto-retry if manual user action (sign-in / verification / safety block) is required
                if flow_err.code in (
                    "FLOW_SIGNIN_REQUIRED",
                    "FLOW_CAPTCHA_OR_VERIFICATION",
                    "FLOW_BROWSER_DISCONNECTED",
                    "FLOW_VIDEO_MODEL_BLOCKED",
                ):
                    raise
                if attempt < self.max_retries:
                    time.sleep(2.0)
        assert last_err is not None
        raise last_err

    def _run_single_attempt(
        self,
        project_id: str,
        scene_id: str,
        full_prompt: str,
        model: str = "Nano Banana 2",
        ratio: str = "9:16",
    ) -> SceneImageRecord:
        status = self.browser_manager.get_status()
        if not status.get("playwrightInstalled"):
            raise FlowAutomationError(
                "FLOW_BROWSER_DISCONNECTED",
                "Playwright is not installed or browser is disconnected. Connect Google Flow browser in Studio or upload a scene image manually.",
            )

        page = self.browser_manager.get_page()
        if page is None:
            st = self.browser_manager.start_or_recover_browser()
            if st.get("status") == "waiting_for_signin":
                raise FlowAutomationError("FLOW_SIGNIN_REQUIRED", st.get("message", "Google Sign-In required."))
            page = self.browser_manager.get_page()
            if page is None:
                raise FlowAutomationError(
                    "FLOW_BROWSER_DISCONNECTED",
                    st.get("message", "Google Flow browser is disconnected."),
                )

        # 1. Verify sign-in state and ensure no CAPTCHA / verification challenge is active
        signin_state = self.browser_manager.check_flow_signin_state()
        if signin_state.get("status") == "waiting_for_signin":
            raise FlowAutomationError(
                "FLOW_SIGNIN_REQUIRED",
                signin_state.get(
                    "message",
                    "Google Sign-In is required in the Playwright browser window before generating images.",
                ),
            )

        self.browser_manager.state.status = "generating_images"
        self.browser_manager.state.message = f"Generating scene {scene_id} in Google Flow ({model})..."

        try:
            body_text = (page.locator("body").inner_text(timeout=5000) or "").lower()
        except Exception:
            body_text = ""

        captcha_visible = False
        try:
            frame = page.locator('iframe[src*="recaptcha/api2/bframe"], iframe[title*="challenge" i]')
            captcha_visible = frame.count() > 0 and frame.first.is_visible()
        except Exception:
            pass
        if captcha_visible or "verify it's you" in body_text:
            self.browser_manager.state.status = "waiting_for_signin"
            self.browser_manager.state.message = (
                "Google requires manual account verification in the browser window. Complete the check and retry."
            )
            self.browser_manager._take_screenshot_impl("captcha-or-verification")
            raise FlowAutomationError(
                "FLOW_CAPTCHA_OR_VERIFICATION",
                self.browser_manager.state.message,
            )

        # 2. Ensure we are inside a Google Flow Project (`/project/{uuid}`)
        self.project_navigator.flow_url = self.browser_manager.flow_url
        self.project_navigator.ensure_project_in_context(
            page,
            name=f"Studio {project_id}",
            campaign=project_id,
        )

        # 3. Switch toolbar to Image mode and select Nano Banana model & 9:16 aspect ratio
        self._select_nano_banana_and_aspect_ratio(page, model=model, ratio=ratio)

        # 4. Safety check: ensure no video model (Veo / Omni Flash) is active
        is_safe_model, detected_model = self.project_navigator.verify_not_video_model(page)
        if not is_safe_model:
            self.browser_manager.state.status = "generation_failed"
            self.browser_manager.state.message = (
                f"Safety block: active Google Flow model '{detected_model}' is a paid video model. "
                "Switch the Flow toolbar to Image / Nano Banana 2 and retry."
            )
            self.browser_manager._take_screenshot_impl("video-model-blocked")
            raise FlowAutomationError("FLOW_VIDEO_MODEL_BLOCKED", self.browser_manager.state.message)

        # 5. Locate prompt input using new project-based Flow UI selectors
        prompt_box = self._locate_prompt_input(page)
        if prompt_box is None:
            # Try creating/entering a project explicitly if we were still on the landing list
            self.project_navigator.create_new_project(page, name=f"Studio {project_id}", campaign=project_id)
            self._select_nano_banana_and_aspect_ratio(page, model=model, ratio=ratio)
            prompt_box = self._locate_prompt_input(page)

        if prompt_box is None:
            self.browser_manager.state.status = "generation_failed"
            self.browser_manager.state.message = (
                "Could not find the image prompt input inside the Google Flow project. "
                "Ensure you have opened a project inside the Flow browser window."
            )
            self.browser_manager._take_screenshot_impl("no-prompt-input")
            raise FlowAutomationError("FLOW_UI_CHANGED", self.browser_manager.state.message)

        # Snapshot existing image UUIDs and candidate image sources before submitting
        existing_uuids = self._collect_media_uuids(page)
        existing_srcs = self._collect_candidate_image_sources(page)

        try:
            page.keyboard.press("Escape")
            page.wait_for_timeout(300)
        except Exception:
            pass

        # 6. Fill the prompt using safe click + clear + delayed typing (works with contenteditable & textarea)
        prompt_box.click(timeout=5000)
        try:
            prompt_box.fill("", timeout=3000)
            page.wait_for_timeout(150)
            prompt_box.type(full_prompt, delay=12)
        except Exception:
            try:
                prompt_box.fill(full_prompt, timeout=5000)
            except Exception:
                page.keyboard.press("Control+A")
                page.keyboard.press("Backspace")
                page.keyboard.type(full_prompt, delay=10)
        page.wait_for_timeout(500)

        # 7. Submit via Generate button (`arrow_forward`, `Créer`, `Generate`) or Enter key
        submit_btn = self._locate_generate_button(page)
        if submit_btn is not None:
            submit_btn.click(timeout=5000)
        else:
            prompt_box.press("Enter")

        # 8. Handle Google Flow's Agent confirmation dialog ("Accepter" / "Approve") within a 5s window
        self._handle_agent_confirmation_if_present(page, wait_ms=5000)

        # 9. Wait for a new generated image (UUID via `media.getMediaUrlRedirect` or new DOM image src)
        new_src_or_uuid, is_uuid = self._wait_for_new_image(page, existing_uuids, existing_srcs)
        raw_bytes = self._download_image_bytes(page, new_src_or_uuid, is_uuid=is_uuid)

        try:
            record = self.download_manager.verify_and_store_image(
                raw_bytes=raw_bytes,
                project_id=project_id,
                scene_id=scene_id,
                prompt=full_prompt,
                source="google_flow_nano_banana",
                ratio=ratio,
            )
            self.project_navigator.register_task_in_project(
                project_id,
                {
                    "type": "scene_image",
                    "scene_id": scene_id,
                    "version_id": record.version_id,
                    "model": model,
                    "ratio": ratio,
                },
            )
            self.browser_manager.state.status = "ready"
            self.browser_manager.state.message = f"Scene {scene_id} image generated and verified."
            return record
        except Exception as exc:
            self.browser_manager.state.status = "generation_failed"
            self.browser_manager.state.message = f"Downloaded image failed verification: {exc}"
            raise FlowAutomationError("FLOW_DOWNLOAD_FAILED", self.browser_manager.state.message) from exc

    def _select_nano_banana_and_aspect_ratio(
        self,
        page: Any,
        model: str = "Nano Banana 2",
        ratio: str = "9:16",
    ) -> None:
        """Switches toolbar to Image mode, selects Nano Banana 2 / Pro / Imagen, and sets 9:16 vertical ratio."""
        self.project_navigator.switch_to_image_mode(page)
        self.project_navigator.select_image_model(page, preferred_model=model)
        self.project_navigator.select_aspect_ratio(page, ratio=ratio)

    def _locate_prompt_input(self, page: Any) -> Any:
        selectors = [
            lambda: page.locator('[contenteditable="true"]:visible'),
            lambda: page.locator("textarea:visible"),
            lambda: page.get_by_role("textbox", name="Prompt"),
            lambda: page.get_by_placeholder("Describe"),
            lambda: page.get_by_placeholder("prompt"),
            lambda: page.get_by_placeholder("Generate"),
            lambda: page.locator('[contenteditable="true"]'),
            lambda: page.locator("textarea"),
        ]
        for getter in selectors:
            try:
                loc = getter()
                if loc.count() > 0 and loc.first.is_visible():
                    return loc.first
            except Exception:
                continue
        return None

    def _locate_generate_button(self, page: Any) -> Any:
        # First try explicit CSS/text locators from google-flow-browser-mcp (`arrow_forward`, `Créer`, `Generate`)
        css_candidates = [
            'button:has-text("arrow_forward")',
            'button:has-text("Generate")',
            'button:has-text("Créer")',
            'button[aria-label*="Generate" i]',
            'button[aria-label*="Créer" i]',
            'button[aria-label*="Send" i]',
        ]
        for sel in css_candidates:
            try:
                loc = page.locator(sel).first
                if loc.count() > 0 and loc.is_visible() and loc.is_enabled():
                    return loc
            except Exception:
                continue

        for name in ("arrow_forward", "Generate", "Créer", "Create", "Send", "Run", "Submit"):
            try:
                btn = page.get_by_role("button", name=name, exact=False)
                if btn.count() > 0 and btn.first.is_visible() and btn.first.is_enabled():
                    return btn.first
            except Exception:
                continue
        return None

    def _handle_agent_confirmation_if_present(self, page: Any, wait_ms: int = 5000) -> str:
        """Handles Google Flow's Agent confirmation dialog ('Accepter' / 'Approve') if it appears after clicking Generate."""
        deadline = time.time() + (wait_ms / 1000.0)
        while time.time() < deadline:
            try:
                accept_btn = page.locator('button:has-text("Accepter"), button:has-text("Approve")').first
                if accept_btn.count() > 0 and accept_btn.is_visible():
                    accept_btn.click(timeout=3000)
                    page.wait_for_timeout(500)
                    return "agent"
            except Exception:
                pass
            # Also exit early if a new image has already started rendering
            time.sleep(0.4)
        return "direct"

    def _collect_media_uuids(self, page: Any) -> set[str]:
        """Extracts Google Flow media UUIDs (`media.getMediaUrlRedirect?name=<uuid>`) from visible `<img>` elements."""
        uuids: set[str] = set()
        try:
            found = page.evaluate(
                """() => {
                    const imgs = Array.from(document.querySelectorAll('img'));
                    const out = [];
                    imgs.forEach(img => {
                        const src = img.src || '';
                        const match = src.match(/media\\.getMediaUrlRedirect\\?name=([a-f0-9-]+)/i);
                        if (match && (img.naturalWidth > 100 || img.width > 100)) {
                            out.push(match[1]);
                        }
                    });
                    return [...new Set(out)];
                }"""
            )
            if isinstance(found, list):
                uuids.update(str(u) for u in found if u)
        except Exception:
            pass
        return uuids

    def _collect_candidate_image_sources(self, page: Any) -> set[str]:
        srcs: set[str] = set()
        try:
            imgs = page.locator("img").all()
            for img in imgs:
                src = img.get_attribute("src") or ""
                w = img.evaluate("el => el.naturalWidth || el.width || 0")
                h = img.evaluate("el => el.naturalHeight || el.height || 0")
                if src and (w >= 200 or h >= 200 or src.startswith("data:image/") or src.startswith("blob:")):
                    srcs.add(src)
        except Exception:
            pass
        return srcs

    def _detect_and_recover_failed_card(self, page: Any) -> bool:
        """Detects Google Flow 'Failed / We noticed some unusual activity...' cards and clicks the
        card's in-place retry/regenerate button so generation recovers automatically.
        """
        try:
            recovered = page.evaluate(
                """() => {
                    const bodyText = document.body?.innerText || '';
                    if (!bodyText.includes('We noticed some unusual activity') &&
                        !bodyText.includes('You have not been charged for this generation') &&
                        !bodyText.includes('Failed')) {
                        return false;
                    }
                    const allEls = Array.from(document.querySelectorAll('div, article, section, li'));
                    const failedCard = allEls.reverse().find(el => {
                        const t = (el.innerText || '').trim();
                        return (
                            (t.includes('We noticed some unusual activity') ||
                             t.includes('You have not been charged for this generation') ||
                             (t.startsWith('Failed') && t.length < 350)) &&
                            el.querySelectorAll('button').length >= 1 &&
                            el.offsetParent !== null
                        );
                    });
                    if (failedCard) {
                        const btns = Array.from(failedCard.querySelectorAll('button')).filter(b => b.offsetParent !== null);
                        const retryBtn = btns.find(b => {
                            const txt = ((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '')).toLowerCase();
                            return txt.includes('refresh') || txt.includes('retry') || txt.includes('replay') ||
                                   txt.includes('try again') || txt.includes('réessayer') || txt.includes('relancer');
                        }) || btns[0];
                        if (retryBtn) {
                            retryBtn.click();
                            return 'clicked_retry';
                        }
                    }
                    return 'detected_failed';
                }"""
            )
            if recovered == "clicked_retry":
                page.wait_for_timeout(2000)
                self._handle_agent_confirmation_if_present(page, wait_ms=3000)
                return True
            if recovered == "detected_failed":
                return True
        except Exception:
            pass
        return False

    def _wait_for_new_image(
        self,
        page: Any,
        previous_uuids: set[str],
        previous_srcs: set[str],
    ) -> tuple[str, bool]:
        """Polls the DOM for newly generated Flow media UUIDs or candidate `<img>` sources,
        and auto-retries if Google Flow shows a 'Failed / unusual activity' card.
        """
        deadline = time.time() + self.timeout_seconds
        in_card_retries = 0
        max_in_card_retries = 2

        while time.time() < deadline:
            # 1. Primary detection from google-flow-browser-mcp: `media.getMediaUrlRedirect?name=<uuid>`
            current_uuids = self._collect_media_uuids(page)
            new_uuids = [u for u in current_uuids if u not in previous_uuids]
            if new_uuids:
                return new_uuids[-1], True

            # 2. Fallback detection: new large `<img>` src (blob:, data:image/, or signed https URL)
            current_srcs = self._collect_candidate_image_sources(page)
            diff_srcs = [s for s in current_srcs if s not in previous_srcs]
            if diff_srcs:
                latest_src = diff_srcs[-1]
                m = UUID_MEDIA_REGEX.search(latest_src)
                if m:
                    return m.group(1), True
                return latest_src, False

            # 3. Check for Google Flow 'Failed / We noticed some unusual activity' card & auto-regenerate
            if self._detect_and_recover_failed_card(page):
                in_card_retries += 1
                self.browser_manager.state.message = (
                    f"Flow card reported 'Failed / unusual activity' — auto-regenerating (attempt {in_card_retries}/{max_in_card_retries})..."
                )
                if in_card_retries > max_in_card_retries:
                    try:
                        page.reload(wait_until="domcontentloaded", timeout=20000)
                        page.wait_for_timeout(2500)
                    except Exception:
                        pass
                    raise FlowAutomationError(
                        "FLOW_GENERATION_FAILED",
                        "Google Flow reported 'Failed: We noticed some unusual activity'. Auto-retrying scene generation...",
                    )
                time.sleep(3.0)
                continue

            # 4. Check for explicit policy / generation error alerts
            try:
                alerts = page.get_by_role("alert").all()
                for al in alerts:
                    if al.is_visible():
                        txt = (al.inner_text() or "").strip()
                        if any(
                            k in txt.lower()
                            for k in ("failed", "error", "unable", "limit", "blocked", "erreur", "impossible")
                        ):
                            self.browser_manager.state.status = "generation_failed"
                            self.browser_manager.state.message = f"Google Flow reported an error: {txt}"
                            raise FlowAutomationError("FLOW_GENERATION_FAILED", self.browser_manager.state.message)
            except FlowAutomationError:
                raise
            except Exception:
                pass

            time.sleep(1.5)

        self.browser_manager.state.status = "generation_failed"
        self.browser_manager.state.message = (
            f"Google Flow image generation timed out after {self.timeout_seconds}s. "
            "Check the Flow browser window or retry the scene."
        )
        self.browser_manager._take_screenshot_impl("generation-timeout")
        raise FlowAutomationError("FLOW_TIMEOUT", self.browser_manager.state.message)

    def _download_image_bytes(self, page: Any, src_or_uuid: str, is_uuid: bool = False) -> bytes:
        """Downloads the generated image via the authenticated browser context without losing the project page."""
        target_url = (
            f"https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name={src_or_uuid}"
            if is_uuid
            else src_or_uuid
        )

        if target_url.startswith("data:image/"):
            comma = target_url.find(",")
            if comma < 0:
                raise FlowAutomationError("FLOW_DOWNLOAD_FAILED", "Malformed data:image URL from Google Flow.")
            return base64.b64decode(target_url[comma + 1 :])

        # 1. Try Playwright's authenticated context.request API first (preserves current page state & cookies)
        if target_url.startswith("http") and getattr(page, "context", None) is not None:
            try:
                api_resp = page.context.request.get(target_url, timeout=20000)
                if api_resp.ok:
                    body = api_resp.body()
                    if body and len(body) >= 256:
                        return body
            except Exception:
                pass

        # 2. Try in-page authenticated `fetch(..., { credentials: 'include' })` (supports both blob: and http:)
        if target_url.startswith("blob:") or target_url.startswith("http"):
            try:
                b64_data = page.evaluate(
                    """async (targetSrc) => {
                        const res = await fetch(targetSrc, { credentials: 'include' });
                        if (!res.ok) throw new Error('HTTP ' + res.status);
                        const buf = await res.arrayBuffer();
                        const bytes = new Uint8Array(buf);
                        let binary = '';
                        for (let i = 0; i < bytes.length; i += 0x8000) {
                            binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
                        }
                        return btoa(binary);
                    }""",
                    target_url,
                )
                if b64_data:
                    return base64.b64decode(b64_data)
            except Exception:
                if target_url.startswith("http"):
                    try:
                        with urllib.request.urlopen(target_url, timeout=20) as resp:
                            return resp.read()
                    except Exception:
                        pass

        raise FlowAutomationError(
            "FLOW_DOWNLOAD_FAILED",
            f"Unable to download generated image from Google Flow source: {target_url[:100]}",
        )
