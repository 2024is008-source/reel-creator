"""Background Queue & Per-Scene Job Manager for Google Flow / Nano Banana Image Automation."""
from __future__ import annotations

import base64
import queue
import threading
import time
import uuid
from typing import Any, Literal

from pydantic import BaseModel, Field

from .browser_manager import BrowserManager
from .flow_automation import FlowAutomationError, FlowAutomationRunner, FlowProjectNavigator
from .image_download import ImageDownloadManager, SceneImageRecord

JobStatus = Literal["queued", "running", "waiting_for_signin", "completed", "failed", "cancelled"]


class SceneGenerationJob(BaseModel):
    job_id: str
    project_id: str
    scene_id: str
    scene_number: int = 1
    visual_description: str
    image_prompt: str
    visual_bible: dict[str, Any] | None = None
    camera_movement: str = "slow zoom in"
    model: str = "Nano Banana 2"
    ratio: str = "9:16"
    status: JobStatus = "queued"
    progress: int = Field(default=0, ge=0, le=100)
    error_code: str | None = None
    error_message: str | None = None
    result: SceneImageRecord | None = None
    attempts: int = 0
    created_at: float = Field(default_factory=time.time)
    updated_at: float = Field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        if hasattr(self, "model_dump"):
            return self.model_dump()  # type: ignore[attr-defined]
        return self.dict()


class FlowJobManager:
    def __init__(
        self,
        browser_manager: BrowserManager | None = None,
        download_manager: ImageDownloadManager | None = None,
        project_navigator: FlowProjectNavigator | None = None,
    ) -> None:
        self.browser_manager = browser_manager or BrowserManager()
        self.download_manager = download_manager or ImageDownloadManager()
        self.project_navigator = project_navigator or FlowProjectNavigator(flow_url=self.browser_manager.flow_url)
        self.runner = FlowAutomationRunner(
            self.browser_manager,
            self.download_manager,
            project_navigator=self.project_navigator,
        )
        self._lock = threading.RLock()
        self._jobs: dict[str, SceneGenerationJob] = {}
        self._scene_active_job: dict[str, str] = {}
        self._queue: queue.Queue[str] = queue.Queue()
        self._paused_for_signin = False
        self._worker = threading.Thread(target=self._worker_loop, daemon=True, name="flow-job-worker")
        self._worker.start()

    def _scene_key(self, project_id: str, scene_id: str) -> str:
        return f"{project_id}:{scene_id}"

    def enqueue_scene(
        self,
        project_id: str,
        scene_id: str,
        scene_number: int,
        visual_description: str,
        image_prompt: str,
        visual_bible: dict[str, Any] | None = None,
        camera_movement: str = "slow zoom in",
        model: str = "Nano Banana 2",
        ratio: str = "9:16",
        force: bool = False,
    ) -> SceneGenerationJob:
        with self._lock:
            key = self._scene_key(project_id, scene_id)
            existing_id = self._scene_active_job.get(key)
            if existing_id and not force:
                existing = self._jobs.get(existing_id)
                if existing and existing.status in ("queued", "running"):
                    return existing

            job_id = f"job_{uuid.uuid4().hex[:10]}"
            job = SceneGenerationJob(
                job_id=job_id,
                project_id=project_id,
                scene_id=scene_id,
                scene_number=scene_number,
                visual_description=visual_description,
                image_prompt=image_prompt,
                visual_bible=visual_bible,
                camera_movement=camera_movement,
                model=model,
                ratio=ratio,
                status="queued",
                progress=5,
            )
            self._jobs[job_id] = job
            self._scene_active_job[key] = job_id
            self._queue.put(job_id)
            return job

    def retry_scene_job(self, job_id: str, updated_prompt: str | None = None) -> SceneGenerationJob:
        with self._lock:
            old = self._jobs.get(job_id)
            if not old:
                raise KeyError(f"Job '{job_id}' not found.")
            self._paused_for_signin = False
            return self.enqueue_scene(
                project_id=old.project_id,
                scene_id=old.scene_id,
                scene_number=old.scene_number,
                visual_description=old.visual_description,
                image_prompt=updated_prompt if updated_prompt is not None else old.image_prompt,
                visual_bible=old.visual_bible,
                camera_movement=old.camera_movement,
                model=old.model,
                ratio=old.ratio,
                force=True,
            )

    def discover_ui(self, page_name: str = "main") -> dict[str, Any]:
        """Discovers UI elements on the active Google Flow page via `FlowProjectNavigator`."""
        def _run() -> dict[str, Any]:
            page = self.browser_manager.get_page()
            if page is None:
                return {"ok": False, "error": "Google Flow browser is not connected."}
            return {"ok": True, **self.project_navigator.discover_ui(page, page_name=page_name)}
        return self.browser_manager.run(_run)

    def upload_manual_scene_image(
        self,
        project_id: str,
        scene_id: str,
        scene_number: int,
        image_data_url_or_b64: str,
        prompt: str = "",
        ratio: str = "9:16",
    ) -> SceneImageRecord:
        comma = image_data_url_or_b64.find(",")
        b64 = image_data_url_or_b64[comma + 1 :] if comma >= 0 else image_data_url_or_b64
        raw_bytes = base64.b64decode(b64)
        record = self.download_manager.verify_and_store_image(
            raw_bytes=raw_bytes,
            project_id=project_id,
            scene_id=scene_id,
            prompt=prompt or "Manual scene upload",
            source="manual_upload",
            ratio=ratio,
        )
        with self._lock:
            key = self._scene_key(project_id, scene_id)
            job_id = f"job_manual_{uuid.uuid4().hex[:8]}"
            job = SceneGenerationJob(
                job_id=job_id,
                project_id=project_id,
                scene_id=scene_id,
                scene_number=scene_number,
                visual_description=prompt,
                image_prompt=prompt,
                status="completed",
                progress=100,
                result=record,
                attempts=1,
            )
            self._jobs[job_id] = job
            self._scene_active_job[key] = job_id
        return record

    def list_project_jobs(self, project_id: str) -> list[dict[str, Any]]:
        with self._lock:
            items = [j for j in self._jobs.values() if j.project_id == project_id]
            items.sort(key=lambda x: (x.scene_number, x.created_at))
            return [j.to_dict() for j in items]

    def get_queue_summary(self, project_id: str | None = None) -> dict[str, Any]:
        with self._lock:
            jobs = [
                j
                for j in self._jobs.values()
                if project_id is None or j.project_id == project_id
            ]
            counts = {
                "total": len(jobs),
                "queued": sum(1 for j in jobs if j.status == "queued"),
                "running": sum(1 for j in jobs if j.status == "running"),
                "waiting_for_signin": sum(1 for j in jobs if j.status == "waiting_for_signin"),
                "completed": sum(1 for j in jobs if j.status == "completed"),
                "failed": sum(1 for j in jobs if j.status == "failed"),
            }
            return {
                "browser": self.browser_manager.get_status(),
                "pausedForSignin": self._paused_for_signin,
                "counts": counts,
                "jobs": [j.to_dict() for j in sorted(jobs, key=lambda x: (x.scene_number, x.created_at))],
            }

    def _worker_loop(self) -> None:
        while True:
            job_id = self._queue.get()
            try:
                self._process_job(job_id)
            except Exception:
                pass
            finally:
                self._queue.task_done()

    def _process_job(self, job_id: str) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job or job.status == "cancelled":
                return
            if self._paused_for_signin:
                job.status = "waiting_for_signin"
                job.error_code = "FLOW_SIGNIN_REQUIRED"
                job.error_message = (
                    "Queue paused: complete Google Sign-In in the Playwright browser window, then retry."
                )
                job.updated_at = time.time()
                return
            job.status = "running"
            job.progress = 25
            job.attempts += 1
            job.updated_at = time.time()

        try:
            record = self.browser_manager.run(
                self.runner.generate_scene_image,
                project_id=job.project_id,
                scene_id=job.scene_id,
                visual_description=job.visual_description,
                image_prompt=job.image_prompt,
                visual_bible=job.visual_bible,
                camera_movement=job.camera_movement,
                model=job.model,
                ratio=job.ratio,
            )
            with self._lock:
                job.status = "completed"
                job.progress = 100
                job.result = record
                job.error_code = None
                job.error_message = None
                job.updated_at = time.time()
        except FlowAutomationError as flow_err:
            with self._lock:
                if flow_err.code in ("FLOW_SIGNIN_REQUIRED", "FLOW_CAPTCHA_OR_VERIFICATION"):
                    self._paused_for_signin = True
                    job.status = "waiting_for_signin"
                else:
                    job.status = "failed"
                job.progress = 0
                job.error_code = flow_err.code
                job.error_message = flow_err.message
                job.updated_at = time.time()
        except Exception as exc:
            with self._lock:
                job.status = "failed"
                job.progress = 0
                job.error_code = "FLOW_GENERATION_FAILED"
                job.error_message = str(exc)
                job.updated_at = time.time()
