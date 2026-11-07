"""Persistent Playwright & Direct-CDP Browser Context Manager for Google Flow / Nano Banana.

Adapted from `google-flow-browser-mcp` (`connect.js`, `launch-profile.js`, `account-check.js`):
- Supports Anti-Detection Direct Chrome Launch + CDP Attachment (`--remote-debugging-port=9222`,
  `navigator.webdriver=false`) so Google OAuth never blocks sign-in.
- Automatically falls back to Playwright persistent Chromium context when system Chrome is absent.
- Supports Account Verification (`verify_account`) and UI Screenshot capture (`take_screenshot`).
"""
from __future__ import annotations

import concurrent.futures
import os
import shutil
import stat
import subprocess
import threading
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

FlowStatusCode = Literal[
    "browser_disconnected",
    "waiting_for_signin",
    "ready",
    "generating_images",
    "generation_failed",
]

DEFAULT_FLOW_URL = "https://labs.google/fx/tools/flow"
DEFAULT_CDP_PORT = 9222


def find_system_chrome() -> str | None:
    """Locates an installed Google Chrome or Microsoft Edge binary for direct CDP anti-detection launch."""
    env_chrome = os.environ.get("FLOW_CHROME_PATH", "").strip()
    if env_chrome and Path(env_chrome).is_file():
        return env_chrome

    candidates: list[str] = []
    if os.name == "nt":
        local_app = os.environ.get("LOCALAPPDATA", "")
        prog_files = os.environ.get("PROGRAMFILES", "C:\\Program Files")
        prog_x86 = os.environ.get("PROGRAMFILES(X86)", "C:\\Program Files (x86)")
        candidates.extend([
            os.path.join(prog_files, "Google", "Chrome", "Application", "chrome.exe"),
            os.path.join(prog_x86, "Google", "Chrome", "Application", "chrome.exe"),
            os.path.join(local_app, "Google", "Chrome", "Application", "chrome.exe"),
        ])
    else:
        candidates.extend([
            "/opt/google/chrome/chrome",
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            shutil.which("google-chrome") or "",
            shutil.which("google-chrome-stable") or "",
            shutil.which("chromium-browser") or "",
            shutil.which("chromium") or "",
        ])

    for path_str in candidates:
        if path_str and Path(path_str).is_file():
            return str(Path(path_str).resolve())
    return None


class FlowBrowserState:
    def __init__(
        self,
        profile_dir: Path,
        flow_url: str = DEFAULT_FLOW_URL,
        cdp_port: int = DEFAULT_CDP_PORT,
    ) -> None:
        self.profile_dir = profile_dir
        self.flow_url = flow_url
        self.cdp_port = int(os.environ.get("FLOW_CDP_PORT", str(cdp_port)))
        self.browser_mode: str = os.environ.get("FLOW_BROWSER_MODE", "direct-cdp")
        self.expected_account: str = os.environ.get("FLOW_EXPECTED_ACCOUNT", "").strip()
        self.detected_account: str | None = None
        self.status: FlowStatusCode = "browser_disconnected"
        self.message: str = "Playwright browser automation is currently disconnected."
        self.signed_in: bool = False
        self.playwright_installed: bool = self._check_playwright_installed()
        self.headless: bool = os.environ.get("FLOW_HEADLESS", "false").lower() == "true"

    @staticmethod
    def _check_playwright_installed() -> bool:
        try:
            import playwright  # type: ignore[import-not-found] # noqa: F401
            return True
        except Exception:
            return False

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "connected": self.status in ("ready", "generating_images", "waiting_for_signin"),
            "signedIn": self.signed_in,
            "playwrightInstalled": self.playwright_installed,
            "flowUrl": self.flow_url,
            "cdpPort": self.cdp_port,
            "browserMode": self.browser_mode,
            "expectedAccount": self.expected_account or None,
            "detectedAccount": self.detected_account,
            "headless": self.headless,
            "message": self.message,
        }


class BrowserManager:
    """Manages a persistent Google Flow browser session using Direct-CDP anti-detection or Playwright Chromium."""

    def __init__(
        self,
        profile_dir: Path | None = None,
        flow_url: str | None = None,
        cdp_port: int = DEFAULT_CDP_PORT,
    ) -> None:
        base_dir = Path(__file__).resolve().parent.parent
        self.profile_dir = (
            profile_dir
            or Path(os.environ.get("FLOW_BROWSER_PROFILE_DIR", base_dir / ".browser_profile"))
        ).resolve()
        self.screenshots_dir = (base_dir / "storage" / "screenshots-debug").resolve()
        self.flow_url = (flow_url or os.environ.get("GOOGLE_FLOW_URL", DEFAULT_FLOW_URL)).strip()
        self._lock = threading.RLock()
        self._playwright: Any = None
        self._browser: Any = None
        self._context: Any = None
        self._page: Any = None
        self._chrome_proc: subprocess.Popen[bytes] | None = None
        self.state = FlowBrowserState(self.profile_dir, self.flow_url, cdp_port=cdp_port)
        # Playwright's sync API is bound to the thread that started it. FastAPI handles
        # requests on a thread pool and the job queue has its own worker, so every
        # Playwright call is funnelled through this single dedicated thread.
        self._executor = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="playwright")
        self._busy = 0
        self._busy_lock = threading.Lock()
        self._pw_thread_ident: int | None = self._executor.submit(threading.get_ident).result()
        self._secure_profile_directory()

    def run(self, fn: Any, *args: Any, **kwargs: Any) -> Any:
        """Run fn on the Playwright thread (directly if already on it)."""
        if threading.get_ident() == self._pw_thread_ident:
            return fn(*args, **kwargs)
        with self._busy_lock:
            self._busy += 1
        try:
            return self._executor.submit(fn, *args, **kwargs).result()
        finally:
            with self._busy_lock:
                self._busy -= 1

    def _secure_profile_directory(self) -> None:
        """Protect local browser profile data with user-only directory permissions."""
        self.profile_dir.mkdir(parents=True, exist_ok=True)
        try:
            if os.name != "nt":
                os.chmod(self.profile_dir, stat.S_IRWXU)
        except Exception:
            pass

    @staticmethod
    def _is_cdp_listening(cdp_port: int) -> bool:
        url = f"http://127.0.0.1:{cdp_port}/json/version"
        try:
            with urllib.request.urlopen(url, timeout=1.5) as resp:
                return resp.status == 200
        except Exception:
            return False

    def _launch_chrome_direct_cdp(self, playwright_inst: Any, headless: bool) -> tuple[Any, Any, Any] | None:
        """Launches Chrome directly (or attaches to an existing CDP port) so `navigator.webdriver` is false."""
        cdp_port = self.state.cdp_port
        cdp_url = f"http://127.0.0.1:{cdp_port}"

        # 1. Check if Chrome is already running on the CDP port
        if self._is_cdp_listening(cdp_port):
            try:
                browser = playwright_inst.chromium.connect_over_cdp(cdp_url)
                contexts = browser.contexts
                ctx = contexts[0] if contexts else browser.new_context(viewport={"width": 1366, "height": 900})
                pages = [pg for pg in ctx.pages if not pg.is_closed()]
                page = pages[0] if pages else ctx.new_page()
                self.state.browser_mode = "direct-cdp"
                return browser, ctx, page
            except Exception:
                pass

        # 2. If direct-cdp mode is enabled and system Chrome exists, spawn Chrome directly
        if self.state.browser_mode != "playwright":
            chrome_bin = find_system_chrome()
            if chrome_bin:
                self._secure_profile_directory()
                profile_subdir = os.environ.get("FLOW_CHROME_PROFILE_NAME", "").strip()
                args = [
                    chrome_bin,
                    f"--remote-debugging-port={cdp_port}",
                    f"--user-data-dir={self.profile_dir}",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--disable-blink-features=AutomationControlled",
                    "--disable-extensions",
                    "--disable-component-extensions-with-background-pages",
                    "--disable-default-apps",
                    "--disable-popup-blocking",
                    "--disable-sync",
                    "--disable-features=ChromeWhatsNewUI,Translate",
                    "--disable-background-networking",
                    "--window-size=1920,1080",
                ]
                if profile_subdir:
                    args.append(f"--profile-directory={profile_subdir}")
                if headless:
                    args.append("--headless=new")

                try:
                    self._chrome_proc = subprocess.Popen(
                        args,
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
                    for _ in range(18):
                        if self._is_cdp_listening(cdp_port):
                            break
                        time.sleep(0.5)

                    if self._is_cdp_listening(cdp_port):
                        browser = playwright_inst.chromium.connect_over_cdp(cdp_url)
                        contexts = browser.contexts
                        ctx = contexts[0] if contexts else browser.new_context(viewport={"width": 1366, "height": 900})
                        pages = [pg for pg in ctx.pages if not pg.is_closed()]
                        page = pages[0] if pages else ctx.new_page()
                        self.state.browser_mode = "direct-cdp"
                        return browser, ctx, page
                except Exception:
                    pass

        return None

    def _get_status_impl(self) -> dict[str, Any]:
        with self._lock:
            self.state.playwright_installed = FlowBrowserState._check_playwright_installed()
            if self._context is not None:
                try:
                    pages = self._context.pages
                    if pages is None:
                        raise RuntimeError("Browser context closed")
                except Exception:
                    # Crash recovery detection
                    self._cleanup_handles()
                    self.state.status = "browser_disconnected"
                    self.state.signed_in = False
                    self.state.message = "Browser session closed unexpectedly. Click 'Connect Browser' to recover."
            return self.state.to_dict()

    def _cleanup_handles(self) -> None:
        try:
            if self._context is not None and self._browser is None:
                self._context.close()
        except Exception:
            pass
        try:
            if self._browser is not None:
                self._browser.close()
        except Exception:
            pass
        try:
            if self._playwright is not None:
                self._playwright.stop()
        except Exception:
            pass
        try:
            if self._chrome_proc is not None and self._chrome_proc.poll() is None:
                self._chrome_proc.terminate()
        except Exception:
            pass
        self._page = None
        self._context = None
        self._browser = None
        self._playwright = None
        self._chrome_proc = None

    def _start_or_recover_browser_impl(self, headless: bool | None = None) -> dict[str, Any]:
        """Launches or recovers the Google Flow browser (Direct-CDP or persistent Chromium) and checks sign-in."""
        with self._lock:
            if headless is not None:
                self.state.headless = headless

            if not FlowBrowserState._check_playwright_installed():
                self.state.status = "browser_disconnected"
                self.state.signed_in = False
                self.state.message = (
                    "Playwright is not installed in the local Python environment. "
                    "Run local-tts\\install.bat (or `pip install playwright && playwright install chromium`) "
                    "or upload scene images manually."
                )
                return self.state.to_dict()

            try:
                from playwright.sync_api import sync_playwright  # type: ignore[import-not-found]

                if self._context is None:
                    self._secure_profile_directory()
                    self._playwright = sync_playwright().start()

                    # First attempt Direct-CDP anti-detection launch/attach (`navigator.webdriver=false`)
                    cdp_tuple = self._launch_chrome_direct_cdp(self._playwright, self.state.headless)
                    if cdp_tuple is not None:
                        self._browser, self._context, self._page = cdp_tuple
                    else:
                        self.state.browser_mode = "playwright-persistent"
                        self._context = self._playwright.chromium.launch_persistent_context(
                            user_data_dir=str(self.profile_dir),
                            headless=self.state.headless,
                            viewport={"width": 1366, "height": 900},
                            args=[
                                "--disable-blink-features=AutomationControlled",
                                "--disable-extensions",
                                "--disable-component-extensions-with-background-pages",
                                "--disable-default-apps",
                                "--no-first-run",
                                "--no-default-browser-check",
                            ],
                        )

                try:
                    self._context.add_init_script(
                        "Object.defineProperty(navigator, 'webdriver', {get: () => undefined});"
                    )
                except Exception:
                    pass
                pages = [pg for pg in self._context.pages if not pg.is_closed()]
                self._page = pages[0] if pages else self._context.new_page()
                current_url = (self._page.url or "").strip()
                if not current_url or "labs.google" not in current_url:
                    self._page.goto(self.flow_url, wait_until="domcontentloaded", timeout=30000)
                    self._page.wait_for_timeout(1500)
                return self._check_flow_signin_state_impl()
            except Exception as exc:
                self._cleanup_handles()
                self.state.status = "browser_disconnected"
                self.state.signed_in = False
                self.state.message = f"Could not launch Playwright Chromium browser: {exc}"
                return self.state.to_dict()

    def _verify_account_impl(self) -> dict[str, Any]:
        """Inspects the active Flow page for the signed-in Google account email (adapted from `account-check.js`)."""
        with self._lock:
            if self._page is None:
                return {"verified": False, "account": None, "method": "disconnected"}

            expected = self.state.expected_account
            detected: str | None = None
            method = "assumed"
            try:
                chip = self._page.locator(
                    '[data-account-email], [aria-label*="@gmail.com"], [aria-label*="Google Account" i], [data-test-id*="account"]'
                ).first
                if chip.count() > 0:
                    email_attr = chip.get_attribute("data-account-email") or chip.get_attribute("aria-label") or ""
                    txt = (chip.inner_text() or "").strip()
                    combined = f"{email_attr} {txt}".strip()
                    if "@" in combined:
                        for token in combined.replace("(", " ").replace(")", " ").split():
                            if "@" in token:
                                detected = token.strip(",.;:")
                                method = "ui-chip"
                                break
            except Exception:
                pass

            if not detected:
                try:
                    detected = self._page.evaluate(
                        """() => {
                            const nextData = document.getElementById('__NEXT_DATA__')?.textContent;
                            if (nextData) {
                                try {
                                    const parsed = JSON.parse(nextData);
                                    return parsed?.props?.pageProps?.user?.email || null;
                                } catch { return null; }
                            }
                            return null;
                        }"""
                    )
                    if detected:
                        method = "next-data"
                except Exception:
                    pass

            self.state.detected_account = detected
            if expected and detected and expected.lower() not in detected.lower():
                return {
                    "verified": False,
                    "account": detected,
                    "expectedAccount": expected,
                    "method": method,
                    "error": f"Wrong Google account detected: found {detected}, expected {expected}.",
                }
            return {
                "verified": True,
                "account": detected or expected or "signed-in-user",
                "expectedAccount": expected or None,
                "method": method,
            }

    def _check_flow_signin_state_impl(self) -> dict[str, Any]:
        """Inspects the active Google Flow page to determine whether manual Google sign-in is required."""
        with self._lock:
            if self._page is None:
                self.state.status = "browser_disconnected"
                self.state.signed_in = False
                self.state.message = "Browser is not connected."
                return self.state.to_dict()

            try:
                current_url = (self._page.url or "").lower()
                title = (self._page.title() or "").lower()

                # Detect Google login / account verification / sign-in URL
                if "accounts.google.com" in current_url or "signin" in current_url or "signout" in current_url:
                    self.state.status = "waiting_for_signin"
                    self.state.signed_in = False
                    self.state.message = (
                        "Waiting for Google Sign-In. Please sign in to your Google account in the opened "
                        "browser window, then click 'Verify Sign-In'."
                    )
                    return self.state.to_dict()

                needs_signin = "flow.google.com/about" in current_url or current_url.rstrip("/").endswith("/about")
                for role in ("button", "link"):
                    if needs_signin:
                        break
                    for label in (
                        "Sign in",
                        "Sign in with Google",
                        "Se connecter",
                        "Connexion",
                        "Log in",
                        "Create with Google Flow",
                    ):
                        loc = self._page.get_by_role(role, name=label, exact=False)
                        if loc.count() > 0 and loc.first.is_visible():
                            needs_signin = True
                            break
                    if needs_signin:
                        break
                if needs_signin:
                    # Signed-out visitors land on the marketing page; open Google sign-in for them.
                    try:
                        cta = self._page.get_by_role("button", name="Create with Google Flow")
                        if cta.count() > 0 and cta.first.is_visible():
                            cta.first.click(timeout=5000)
                            self._page.wait_for_timeout(2500)
                    except Exception:
                        pass
                    self.state.status = "waiting_for_signin"
                    self.state.signed_in = False
                    self.state.message = (
                        "Google sign-in opened in the Flow browser window. Sign in there, "
                        "then click Verify Sign-In."
                    )
                    return self.state.to_dict()

                acc_info = self._verify_account_impl()
                if not acc_info.get("verified", True):
                    self.state.status = "waiting_for_signin"
                    self.state.signed_in = False
                    self.state.message = acc_info.get("error", "Account mismatch on Google Flow.")
                    return self.state.to_dict()

                self.state.status = "ready"
                self.state.signed_in = True
                self.state.message = f"Google Flow ready ({title or self.flow_url})."
                return self.state.to_dict()
            except Exception as exc:
                self.state.status = "browser_disconnected"
                self.state.signed_in = False
                self.state.message = f"Failed to inspect Google Flow tab: {exc}"
                return self.state.to_dict()

    def _take_screenshot_impl(self, name: str = "debug") -> str | None:
        """Captures a debug screenshot of the current Google Flow page (adapted from `screenshots.js`)."""
        with self._lock:
            if self._page is None:
                return None
            try:
                self.screenshots_dir.mkdir(parents=True, exist_ok=True)
                ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")
                safe_name = "".join(c for c in name if c.isalnum() or c in ("-", "_")) or "shot"
                filepath = self.screenshots_dir / f"{ts}_{safe_name}.png"
                self._page.screenshot(path=str(filepath), full_page=False)
                return str(filepath)
            except Exception:
                return None

    def get_status(self) -> dict[str, Any]:
        # Don't wait behind a long-running generation just to report status.
        if self._busy and threading.get_ident() != self._pw_thread_ident:
            return self.state.to_dict()
        return self.run(self._get_status_impl)

    def start_or_recover_browser(self, headless: bool | None = None) -> dict[str, Any]:
        return self.run(self._start_or_recover_browser_impl, headless)

    def check_flow_signin_state(self) -> dict[str, Any]:
        return self.run(self._check_flow_signin_state_impl)

    def verify_account(self) -> dict[str, Any]:
        return self.run(self._verify_account_impl)

    def take_screenshot(self, name: str = "manual") -> str | None:
        return self.run(self._take_screenshot_impl, name)

    def close(self) -> dict[str, Any]:
        return self.run(self._close_impl)

    def get_page(self) -> Any:
        with self._lock:
            return self._page

    def _close_impl(self) -> dict[str, Any]:
        with self._lock:
            self._cleanup_handles()
            self.state.status = "browser_disconnected"
            self.state.signed_in = False
            self.state.message = "Browser disconnected."
            return self.state.to_dict()
