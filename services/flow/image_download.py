"""Image Download Verification, Version History, and Scene Storage Manager."""
from __future__ import annotations

import base64
import hashlib
import io
import json
import time
from pathlib import Path
from typing import Any

from PIL import Image
from pydantic import BaseModel, Field


class SceneImageRecord(BaseModel):
    version_id: str
    project_id: str
    scene_id: str
    prompt: str
    source: str = Field(default="google_flow_nano_banana")
    width: int
    height: int
    mime_type: str = "image/jpeg"
    file_path: str
    data_url: str
    sha256: str
    created_at: float

    def to_dict(self) -> dict[str, Any]:
        if hasattr(self, "model_dump"):
            return self.model_dump()  # type: ignore[attr-defined]
        return self.dict()


class ImageDownloadManager:
    def __init__(self, storage_root: Path | None = None) -> None:
        base_dir = Path(__file__).resolve().parent.parent
        self.storage_root = (storage_root or (base_dir / "storage" / "projects")).resolve()
        self.storage_root.mkdir(parents=True, exist_ok=True)

    def _scene_dir(self, project_id: str, scene_id: str) -> Path:
        safe_proj = "".join(c for c in project_id if c.isalnum() or c in ("-", "_")) or "default"
        safe_scene = "".join(c for c in scene_id if c.isalnum() or c in ("-", "_")) or "scene"
        d = self.storage_root / safe_proj / "scenes" / safe_scene
        d.mkdir(parents=True, exist_ok=True)
        return d

    def verify_and_store_image(
        self,
        raw_bytes: bytes,
        project_id: str,
        scene_id: str,
        prompt: str,
        source: str = "google_flow_nano_banana",
        ratio: str = "9:16",
    ) -> SceneImageRecord:
        if not raw_bytes or len(raw_bytes) < 256:
            raise ValueError("Downloaded image file is empty or truncated (< 256 bytes).")

        try:
            with Image.open(io.BytesIO(raw_bytes)) as im:
                im.verify()
            with Image.open(io.BytesIO(raw_bytes)) as im:
                rgb = im.convert("RGB")
                w, h = rgb.size
                if w < 128 or h < 128:
                    raise ValueError(f"Image dimensions ({w}x{h}) are too small to be a valid scene painting.")

                if ratio == "16:9":
                    target_w, target_h = 1920, 1080
                elif ratio == "1:1":
                    target_w, target_h = 1080, 1080
                else:
                    target_w, target_h = 1080, 1920
                src_ratio = w / h
                dst_ratio = target_w / target_h
                if abs(src_ratio - dst_ratio) > 0.03:
                    if src_ratio > dst_ratio:
                        new_w = int(h * dst_ratio)
                        left = (w - new_w) // 2
                        rgb = rgb.crop((left, 0, left + new_w, h))
                    else:
                        new_h = int(w / dst_ratio)
                        top = (h - new_h) // 2
                        rgb = rgb.crop((0, top, w, top + new_h))
                rgb = rgb.resize((target_w, target_h), Image.Resampling.LANCZOS)

                out_buf = io.BytesIO()
                rgb.save(out_buf, format="JPEG", quality=92)
                normalized_bytes = out_buf.getvalue()
        except Exception as exc:
            raise ValueError(f"Image verification failed: {exc}") from exc

        digest = hashlib.sha256(normalized_bytes).hexdigest()[:16]
        ts = time.time()
        version_id = f"v_{int(ts * 1000)}_{digest[:6]}"
        scene_dir = self._scene_dir(project_id, scene_id)
        img_path = scene_dir / f"{version_id}.jpg"
        img_path.write_bytes(normalized_bytes)

        b64 = base64.b64encode(normalized_bytes).decode("ascii")
        data_url = f"data:image/jpeg;base64,{b64}"

        record = SceneImageRecord(
            version_id=version_id,
            project_id=project_id,
            scene_id=scene_id,
            prompt=prompt,
            source=source,
            width=target_w,
            height=target_h,
            mime_type="image/jpeg",
            file_path=str(img_path),
            data_url=data_url,
            sha256=digest,
            created_at=ts,
        )
        self._append_version_metadata(scene_dir, record)
        return record

    def _append_version_metadata(self, scene_dir: Path, record: SceneImageRecord) -> None:
        meta_file = scene_dir / "versions.json"
        versions: list[dict[str, Any]] = []
        if meta_file.exists():
            try:
                versions = json.loads(meta_file.read_text(encoding="utf-8"))
            except Exception:
                versions = []
        versions.insert(0, record.to_dict())
        meta_file.write_text(json.dumps(versions[:10], indent=2), encoding="utf-8")

    def list_scene_versions(self, project_id: str, scene_id: str) -> list[dict[str, Any]]:
        scene_dir = self._scene_dir(project_id, scene_id)
        meta_file = scene_dir / "versions.json"
        if not meta_file.exists():
            return []
        try:
            return json.loads(meta_file.read_text(encoding="utf-8"))
        except Exception:
            return []
