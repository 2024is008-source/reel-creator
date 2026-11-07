"""AI Cinematic Motivational Video Studio — Unified Local Backend Service.

Runs locally at http://127.0.0.1:5005 and provides modular services for:
1. Google Gemini API (`/api/gemini/*`) — Script, Story, Captions, Visual Bible, and Scene Prompts
2. Google Flow / Nano Banana Playwright Automation (`/api/flow/*`) — Persistent profile, queue, and version history
3. Local Offline Piper TTS (`/local-tts/*`) — Male & female English WAV narration synthesis
4. FFmpeg & FFprobe Rendering (`/api/ffmpeg/*`) — Audio mixing with ducking + 1080x1920 30FPS H.264/AAC MP4 export
"""
from __future__ import annotations

import base64
import io
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import threading
import wave
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).parent.resolve()
PROJECT_ROOT = BASE_DIR.parent.resolve()
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

# Load .env from project root or local-tts directory if present
for env_candidate in (PROJECT_ROOT / ".env", BASE_DIR / ".env"):
    if env_candidate.is_file():
        for raw_line in env_candidate.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            if k and k not in os.environ:
                os.environ[k] = v

from services.ffmpeg_renderer import (  # noqa: E402
    FFmpegRenderError,
    FFmpegRenderRequest,
    build_mixed_audio_wav_with_ffmpeg,
    is_ffmpeg_available,
    render_project_mp4_with_ffmpeg,
    validate_video_with_ffprobe,
)
from services.flow import FlowJobManager  # noqa: E402
from services.gemini import (  # noqa: E402
    GEMINI_TTS_VOICES,
    GeminiService,
    GeminiServiceError,
    ScriptGenerationRequest,
)

try:
    from piper import PiperVoice, SynthesisConfig  # type: ignore[import-not-found]
    HAS_PIPER_PYTHON = True
except Exception:
    PiperVoice = None  # type: ignore[assignment]
    SynthesisConfig = None  # type: ignore[assignment]
    HAS_PIPER_PYTHON = False

_voices_env = os.environ.get("PIPER_VOICES_DIR", "").strip()
if _voices_env:
    _voices_dir = Path(_voices_env)
    VOICES_DIR = (_voices_dir if _voices_dir.is_absolute() else PROJECT_ROOT / _voices_dir).resolve()
else:
    VOICES_DIR = (BASE_DIR / "voices").resolve()
REFERENCE_VOICES_DIR = (BASE_DIR / "reference_voices").resolve()
PORT = int(os.environ.get("LOCAL_TTS_PORT", "5005"))

VOICE_METADATA: dict[str, dict[str, str]] = {
    "ryan": {
        "gender": "male",
        "description": "Deep, warm cinematic American male narrator — ideal for emotional motivation",
    },
    "joe": {
        "gender": "male",
        "description": "Grounded, steady American male voice — calm and reflective",
    },
    "bryce": {
        "gender": "male",
        "description": "Clear, earnest American male voice — great for discipline & focus",
    },
    "john": {"gender": "male", "description": "Measured American male narrator"},
    "norman": {"gender": "male", "description": "Classic resonant American male voice"},
    "hfc_male": {"gender": "male", "description": "Articulate studio male voice"},
    "kusal": {"gender": "male", "description": "Gentle conversational male voice"},
    "lessac": {
        "gender": "female",
        "description": "Expressive, natural American female narrator — rich emotional delivery",
    },
    "amy": {
        "gender": "female",
        "description": "Warm, soothing American female voice — intimate and hopeful",
    },
    "kristin": {"gender": "female", "description": "Clear, inspiring American female voice"},
    "hfc_female": {"gender": "female", "description": "Balanced studio female narrator"},
    "ljspeech": {"gender": "female", "description": "Classic clear English female voice"},
    "alan": {
        "gender": "male",
        "description": "Warm British male narrator — thoughtful cinematic cadence",
    },
    "northern_english_male": {"gender": "male", "description": "Grounded Northern English male voice"},
    "alba": {"gender": "female", "description": "Soft, expressive British/Scottish female voice"},
    "jenny_dioco": {"gender": "female", "description": "Calm British female voice"},
    "cori": {"gender": "female", "description": "Warm British female narrator"},
}

ALLOWED_ORIGINS = [
    o.strip() for o in os.environ.get("LOCAL_TTS_ORIGINS", "").split(",") if o.strip()
]
ORIGIN_REGEX = (
    r"https://([a-z0-9-]+\.)*lovable\.app|"
    r"https://([a-z0-9-]+\.)*lovableproject\.com|"
    r"http://(localhost|127\.0\.0\.1)(:\d+)?"
)

app = FastAPI(
    title="Cinematic Studio — Unified Local AI, Flow, Piper & FFmpeg Service",
    version="3.0.0",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS or ["*"],
    allow_origin_regex=ORIGIN_REGEX,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.middleware("http")
async def private_network_and_local_guard(request: Request, call_next):
    # Restrict local automation endpoints to local loopback client connections
    client_host = (request.client.host if request.client else "127.0.0.1") or "127.0.0.1"
    if client_host not in ("127.0.0.1", "::1", "localhost", "testclient"):
        return JSONResponse(
            status_code=403,
            content={"detail": "Local studio service only accepts requests from localhost."},
        )
    if request.method == "OPTIONS":
        resp = Response(status_code=204)
    else:
        resp = await call_next(request)
    resp.headers["Access-Control-Allow-Private-Network"] = "true"
    resp.headers["Access-Control-Allow-Origin"] = request.headers.get("origin", "*")
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return resp


def _to_dict(obj: Any) -> Any:
    if hasattr(obj, "to_dict"):
        return obj.to_dict()
    if hasattr(obj, "model_dump"):
        return obj.model_dump()
    if hasattr(obj, "dict"):
        return obj.dict()
    return obj


# Singleton modular service instances
gemini_service = GeminiService()
flow_job_manager = FlowJobManager()
_piper_cache: dict[str, Any] = {}
_piper_lock = threading.Lock()


# ============================================================================
# 1. LOCAL PIPER TTS HELPERS & ENDPOINTS
# ============================================================================

def find_piper_cli() -> str | None:
    candidates = [
        os.environ.get("PIPER_BIN", ""),
        str(BASE_DIR / "piper" / "piper.exe"),
        str(BASE_DIR / "piper" / "piper"),
        str(BASE_DIR / ".venv" / "Scripts" / "piper.exe"),
        str(BASE_DIR / ".venv" / "bin" / "piper"),
        shutil.which("piper") or "",
    ]
    for c in candidates:
        if c and Path(c).is_file():
            return c
    return None


def is_piper_available() -> bool:
    return HAS_PIPER_PYTHON or (find_piper_cli() is not None)


def _is_test_fixture_model(model_path: Path) -> bool:
    try:
        with model_path.open("rb") as f:
            header = f.read(18)
        return header == b"PIPER_TEST_FIXTURE"
    except Exception:
        return False


def list_voices() -> list[dict[str, Any]]:
    VOICES_DIR.mkdir(parents=True, exist_ok=True)
    REFERENCE_VOICES_DIR.mkdir(parents=True, exist_ok=True)
    out: list[dict[str, Any]] = []
    for gv in GEMINI_TTS_VOICES:
        ref_name = gv.get("referenceFile", "reference_whayrs_male.mp3")
        ref_clip = REFERENCE_VOICES_DIR / ref_name
        out.append({
            **gv,
            "hasReferenceAudio": ref_clip.exists(),
        })
    for cfg in sorted(VOICES_DIR.glob("*.onnx.json")):
        vid = cfg.name[: -len(".onnx.json")]
        onnx_path = VOICES_DIR / f"{vid}.onnx"
        if not onnx_path.exists():
            continue
        try:
            meta = json.loads(cfg.read_text(encoding="utf-8"))
        except Exception:
            meta = {}
        lang = meta.get("language", {})
        parts = vid.split("-")
        lang_code = lang.get("code", parts[0] if parts else "en_US")
        speaker = parts[1] if len(parts) > 1 else vid
        quality = parts[2] if len(parts) > 2 else meta.get("audio", {}).get("quality", "medium")
        speaker_info = VOICE_METADATA.get(speaker.lower(), {})
        gender = meta.get("gender") or speaker_info.get("gender", "unknown")
        lang_name_en = lang.get("name_english", "English")
        country_en = lang.get(
            "country_english",
            "United States" if "US" in lang_code else "United Kingdom" if "GB" in lang_code else "",
        )
        language_label = f"{lang_name_en} ({country_en})".strip(" ()") if country_en else lang_name_en
        out.append({
            "id": vid,
            "name": f"{speaker.replace('_', ' ').title()} ({quality.title()})",
            "speaker": speaker.replace("_", " ").title(),
            "language": lang_code,
            "languageName": language_label or lang_code,
            "quality": quality,
            "gender": gender,
            "sampleRate": int(meta.get("audio", {}).get("sample_rate", 22050)),
            "description": meta.get("description")
            or speaker_info.get("description", "Local offline Piper TTS voice model"),
        })
    return out


class GenerateIn(BaseModel):
    text: str = Field(..., min_length=1, max_length=5000)
    voice: str = Field(..., min_length=1, max_length=120, pattern=r"^[A-Za-z0-9_\-:]+$")
    speed: float = Field(1.0, ge=0.5, le=2.0)
    sentenceSilence: float = Field(0.32, ge=0.0, le=1.5)
    referenceAudioDataUrl: str | None = None


def _enhance_clone_reference_audio(audio_bytes: bytes) -> bytes:
    """Prepare a clone reference with speech-focused cleanup before conditioning."""
    if not audio_bytes or shutil.which("ffmpeg") is None:
        return audio_bytes
    try:
        result = subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                "pipe:0",
                "-af",
                "highpass=f=70,lowpass=f=14000,afftdn=nr=10:nf=-35,"
                "loudnorm=I=-16:LRA=7:TP=-1.5",
                "-ar",
                "24000",
                "-ac",
                "1",
                "-f",
                "wav",
                "pipe:1",
            ],
            input=audio_bytes,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        print(f"Reference voice enhancement unavailable; using original sample: {exc}")
        return audio_bytes
    if result.returncode != 0 or not result.stdout:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        print(f"Reference voice enhancement failed; using original sample: {detail[:300]}")
        return audio_bytes
    return result.stdout


def _synthesize_with_python_piper(model_path: Path, text: str, speed: float, sentence_silence: float) -> bytes:
    vid = model_path.stem
    with _piper_lock:
        if vid not in _piper_cache:
            _piper_cache[vid] = PiperVoice.load(str(model_path))
        voice = _piper_cache[vid]
    syn_cfg = SynthesisConfig(length_scale=1.0 / max(0.5, min(2.0, speed)))
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        first = True
        # piper-tts 1.3 yields one chunk per sentence; insert the pause between them.
        for chunk in voice.synthesize(text, syn_config=syn_cfg):
            if first:
                w.setframerate(chunk.sample_rate)
                w.setsampwidth(chunk.sample_width)
                w.setnchannels(chunk.sample_channels)
                first = False
            else:
                silence = int(chunk.sample_rate * sentence_silence) * chunk.sample_width * chunk.sample_channels
                w.writeframes(b"\x00" * silence)
            w.writeframes(chunk.audio_int16_bytes)
        if first:
            raise HTTPException(status_code=500, detail="Piper produced no audio for this text.")
    return buf.getvalue()


def _synthesize_with_cli_piper(
    piper_bin: str, model_path: Path, text: str, speed: float, sentence_silence: float
) -> bytes:
    length_scale = f"{1.0 / max(0.5, min(2.0, speed)):.3f}"
    cmd = [
        piper_bin,
        "--model",
        str(model_path),
        "--length_scale",
        length_scale,
        "--sentence_silence",
        f"{sentence_silence:.2f}",
        "--output_file",
        "-",
    ]
    proc = subprocess.run(cmd, input=text.encode("utf-8"), capture_output=True, timeout=60, check=False)
    if proc.returncode != 0 or not proc.stdout:
        err = proc.stderr.decode("utf-8", errors="replace").strip()
        raise HTTPException(status_code=500, detail=f"Piper CLI synthesis failed: {err or 'empty audio output'}")
    return proc.stdout


def _synthesize_test_fixture_wav(model_path: Path, text: str, speed: float, sample_rate: int = 22050) -> bytes:
    words = max(1, len(text.strip().split()))
    duration = max(0.8, min(30.0, (words * 0.34) / max(0.5, min(2.0, speed))))
    n_samples = int(sample_rate * duration)
    buf = io.BytesIO()
    is_female = any(k in model_path.stem.lower() for k in ("lessac", "amy", "alba", "kristin", "female"))
    base_freq = 210.0 if is_female else 125.0
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        frames = bytearray(n_samples * 2)
        for i in range(n_samples):
            t = i / sample_rate
            syllable = 0.55 + 0.45 * math.sin(2.0 * math.pi * 3.2 * t)
            fade = min(1.0, t / 0.04, (duration - t) / 0.06)
            f0 = base_freq * (1.0 + 0.04 * math.sin(2.0 * math.pi * 1.3 * t))
            sig = (
                0.60 * math.sin(2.0 * math.pi * f0 * t)
                + 0.25 * math.sin(2.0 * math.pi * (f0 * 2.0) * t)
                + 0.15 * math.sin(2.0 * math.pi * (f0 * 3.0) * t)
            )
            val = int(max(-32767, min(32767, sig * syllable * fade * 14000)))
            struct.pack_into("<h", frames, i * 2, val)
        w.writeframes(bytes(frames))
    return buf.getvalue()


@app.get("/local-tts/status")
def status():
    voices_list = list_voices()
    has_fixture = any(_is_test_fixture_model(VOICES_DIR / f"{v['id']}.onnx") for v in voices_list)
    piper_ready = is_piper_available() or has_fixture
    if not piper_ready:
        return {
            "ok": False,
            "status": "not_installed",
            "engine": "piper",
            "piperInstalled": False,
            "voices": len(voices_list),
            "voicesDir": str(VOICES_DIR),
            "message": (
                "Piper TTS runtime is not installed yet. Run local-tts\\install.bat on Windows "
                "(or ./local-tts/install.sh on macOS/Linux) to install Piper and download voice models."
            ),
        }
    if len(voices_list) == 0:
        return {
            "ok": False,
            "status": "unavailable",
            "engine": "piper",
            "piperInstalled": True,
            "voices": 0,
            "voicesDir": str(VOICES_DIR),
            "message": (
                f"Piper TTS is installed, but no .onnx voice models were found in {VOICES_DIR}. "
                "Run local-tts\\install.bat to download English male and female voice models."
            ),
        }
    return {
        "ok": True,
        "status": "running",
        "engine": "piper",
        "piperInstalled": True,
        "voices": len(voices_list),
        "voicesDir": str(VOICES_DIR),
        "message": f"Local Piper TTS running ({len(voices_list)} voice model{'s' if len(voices_list) != 1 else ''} ready).",
    }


@app.get("/local-tts/voices")
def voices():
    installed = list_voices()
    return {
        "voices": installed,
        "piperInstalled": is_piper_available()
        or any(_is_test_fixture_model(VOICES_DIR / f"{v['id']}.onnx") for v in installed),
        "voicesDir": str(VOICES_DIR),
    }


@app.post("/local-tts/generate")
def generate(body: GenerateIn):
    clean_text = " ".join(body.text.strip().split())
    if not clean_text:
        raise HTTPException(status_code=400, detail="Narration text cannot be empty.")

    # 1. Handle Gemini TTS & Cloned Reference Voices ("gemini:clone_whayrs_male", "gemini:clone_reference", etc.)
    if body.voice.startswith("gemini:"):
        voice_meta = next((v for v in GEMINI_TTS_VOICES if v["id"] == body.voice), GEMINI_TTS_VOICES[0])
        is_male = voice_meta.get("gender") == "male"
        ref_filename = voice_meta.get("referenceFile", "reference_whayrs_male.mp3" if is_male else "reference_calm_female.mp3")
        preferred_piper = voice_meta.get("fallbackPiper", "en_GB-alan-medium" if is_male else "en_US-amy-medium")

        ref_bytes: bytes | None = None
        ref_mime = "audio/mp3"
        if body.referenceAudioDataUrl:
            comma = body.referenceAudioDataUrl.find(",")
            b64 = body.referenceAudioDataUrl[comma + 1 :] if comma >= 0 else body.referenceAudioDataUrl
            ref_bytes = base64.b64decode(b64)
        else:
            ref_clip = REFERENCE_VOICES_DIR / ref_filename
            if ref_clip.exists():
                ref_bytes = ref_clip.read_bytes()

        if ref_bytes:
            ref_bytes = _enhance_clone_reference_audio(ref_bytes)

        if gemini_service.api_key:
            try:
                wav_bytes = gemini_service.synthesize_speech_wav(
                    text=clean_text,
                    voice_id=body.voice,
                    speed=body.speed,
                    reference_audio_bytes=ref_bytes,
                    reference_mime_type=ref_mime,
                )
                return Response(wav_bytes, media_type="audio/wav")
            except GeminiServiceError as g_err:
                fallback_onnx = VOICES_DIR / f"{preferred_piper}.onnx"
                if not fallback_onnx.exists():
                    raise HTTPException(status_code=g_err.http_status, detail=g_err.message) from g_err
                model_path = fallback_onnx
                cfg_path = VOICES_DIR / f"{preferred_piper}.onnx.json"
        else:
            fallback_candidates = [
                VOICES_DIR / f"{preferred_piper}.onnx",
                VOICES_DIR / ("en_GB-alan-medium.onnx" if is_male else "en_US-amy-medium.onnx"),
                VOICES_DIR / ("en_US-ryan-high.onnx" if is_male else "en_US-lessac-medium.onnx"),
            ] + sorted(VOICES_DIR.glob("*.onnx"))
            found_onnx = next((p for p in fallback_candidates if p.exists()), None)
            if found_onnx is None:
                raise HTTPException(
                    status_code=401,
                    detail="GEMINI_API_KEY is not configured for Gemini TTS voice cloning. Set GEMINI_API_KEY in Settings or .env.",
                )
            model_path = found_onnx
            cfg_path = VOICES_DIR / f"{found_onnx.stem}.onnx.json"
    else:
        model_path = VOICES_DIR / f"{body.voice}.onnx"
        cfg_path = VOICES_DIR / f"{body.voice}.onnx.json"
        if not model_path.exists() or not cfg_path.exists():
            raise HTTPException(
                status_code=404,
                detail=(
                    f"Voice model '{body.voice}' is not installed in {VOICES_DIR}. "
                    "Run local-tts\\install.bat to download compatible Piper voice models."
                ),
            )

    if _is_test_fixture_model(model_path):
        try:
            meta = json.loads(cfg_path.read_text(encoding="utf-8"))
            sr = int(meta.get("audio", {}).get("sample_rate", 22050))
        except Exception:
            sr = 22050
        wav_bytes = _synthesize_test_fixture_wav(model_path, clean_text, body.speed, sr)
        return Response(wav_bytes, media_type="audio/wav")

    if HAS_PIPER_PYTHON:
        wav_bytes = _synthesize_with_python_piper(model_path, clean_text, body.speed, body.sentenceSilence)
        return Response(wav_bytes, media_type="audio/wav")

    piper_bin = find_piper_cli()
    if piper_bin:
        wav_bytes = _synthesize_with_cli_piper(piper_bin, model_path, clean_text, body.speed, body.sentenceSilence)
        return Response(wav_bytes, media_type="audio/wav")

    raise HTTPException(
        status_code=503,
        detail=(
            "Local Piper TTS engine is not installed. Please run local-tts\\install.bat (Windows) "
            "or ./local-tts/install.sh (macOS/Linux) to install piper-tts and download voice models."
        ),
    )


# ============================================================================
# 2. UNIFIED PLATFORM STATUS & SETTINGS ENDPOINTS
# ============================================================================

class StudioSettingsUpdate(BaseModel):
    geminiApiKey: str | None = None
    geminiModel: str | None = None
    googleFlowUrl: str | None = None
    flowHeadless: bool | None = None
    flowExpectedAccount: str | None = None
    flowCdpPort: int | None = None
    flowBrowserMode: str | None = None


@app.get("/api/status")
def api_status():
    return {
        "gemini": gemini_service.get_status(),
        "flow": flow_job_manager.browser_manager.get_status(),
        "piper": status(),
        "ffmpeg": is_ffmpeg_available(),
    }


@app.post("/api/settings")
def update_settings(body: StudioSettingsUpdate):
    if body.geminiApiKey is not None or body.geminiModel is not None:
        gemini_service.set_credentials(api_key=body.geminiApiKey, model=body.geminiModel)
    if body.googleFlowUrl:
        flow_job_manager.browser_manager.flow_url = body.googleFlowUrl.strip()
        flow_job_manager.browser_manager.state.flow_url = body.googleFlowUrl.strip()
        flow_job_manager.project_navigator.flow_url = body.googleFlowUrl.strip()
    if body.flowHeadless is not None:
        flow_job_manager.browser_manager.state.headless = body.flowHeadless
    if body.flowExpectedAccount is not None:
        flow_job_manager.browser_manager.state.expected_account = body.flowExpectedAccount.strip()
    if body.flowCdpPort is not None:
        flow_job_manager.browser_manager.state.cdp_port = body.flowCdpPort
    if body.flowBrowserMode:
        flow_job_manager.browser_manager.state.browser_mode = body.flowBrowserMode.strip()
    return api_status()


# ============================================================================
# 3. GOOGLE GEMINI SCRIPT, STORY & VISUAL BIBLE ENDPOINTS
# ============================================================================

@app.post("/api/gemini/script")
def api_gemini_script(req: ScriptGenerationRequest):
    try:
        result = gemini_service.generate_motivational_script(req)
        return {"ok": True, "script": _to_dict(result)}
    except GeminiServiceError as g_err:
        return JSONResponse(
            status_code=g_err.http_status,
            content={"ok": False, "code": g_err.code, "error": g_err.message},
        )
    except Exception as exc:
        return JSONResponse(
            status_code=500,
            content={"ok": False, "code": "GEMINI_API_ERROR", "error": str(exc)},
        )




class UploadReferenceVoiceInput(BaseModel):
    audio_data_url: str
    name: str = "Custom Cloned Voice"


@app.get("/api/gemini/reference-voice")
def api_get_reference_voice():
    REFERENCE_VOICES_DIR.mkdir(parents=True, exist_ok=True)
    ref_clip = REFERENCE_VOICES_DIR / "reference_calm_female.mp3"
    if not ref_clip.exists():
        return {"ok": False, "exists": False}
    b64 = base64.b64encode(ref_clip.read_bytes()).decode("ascii")
    return {
        "ok": True,
        "exists": True,
        "name": "Cloned Reference Voice (Words Hold Power — Calm Reflective Female)",
        "audioDataUrl": f"data:audio/mpeg;base64,{b64}",
    }


@app.post("/api/gemini/upload-reference-voice")
def api_upload_reference_voice(body: UploadReferenceVoiceInput):
    REFERENCE_VOICES_DIR.mkdir(parents=True, exist_ok=True)
    comma = body.audio_data_url.find(",")
    b64 = body.audio_data_url[comma + 1 :] if comma >= 0 else body.audio_data_url
    raw_bytes = base64.b64decode(b64)
    if len(raw_bytes) < 256:
        raise HTTPException(status_code=400, detail="Uploaded reference voice audio is empty.")
    ref_clip = REFERENCE_VOICES_DIR / "reference_calm_female.mp3"
    ref_clip.write_bytes(raw_bytes)
    return {
        "ok": True,
        "name": body.name,
        "sizeBytes": len(raw_bytes),
        "voiceId": "gemini:clone_reference",
    }


# ============================================================================
# 4. GOOGLE FLOW / NANO BANANA PLAYWRIGHT AUTOMATION ENDPOINTS
# ============================================================================

class FlowConnectInput(BaseModel):
    headless: bool | None = None


class FlowEnqueueSceneInput(BaseModel):
    project_id: str
    scene_id: str
    scene_number: int = 1
    visual_description: str
    image_prompt: str
    visual_bible: dict[str, Any] | None = None
    camera_movement: str = "slow zoom in"
    model: str = "Nano Banana 2"
    ratio: str = "9:16"
    force: bool = False


class FlowEnqueueBatchInput(BaseModel):
    project_id: str
    visual_bible: dict[str, Any] | None = None
    scenes: list[FlowEnqueueSceneInput]


class FlowRetryInput(BaseModel):
    job_id: str
    image_prompt: str | None = None


class FlowDiscoverUiInput(BaseModel):
    page: str = "main"


class ManualSceneUploadInput(BaseModel):
    project_id: str
    scene_id: str
    scene_number: int = 1
    image_data_url: str
    prompt: str = ""
    ratio: str = "9:16"


@app.get("/api/flow/status")
def api_flow_status(project_id: str | None = None):
    return flow_job_manager.get_queue_summary(project_id=project_id)


@app.post("/api/flow/connect")
def api_flow_connect(body: FlowConnectInput):
    st = flow_job_manager.browser_manager.start_or_recover_browser(headless=body.headless)
    return {"ok": st.get("connected", False), "browser": st}


@app.post("/api/flow/verify-signin")
def api_flow_verify_signin():
    st = flow_job_manager.browser_manager.check_flow_signin_state()
    if st.get("signedIn"):
        flow_job_manager._paused_for_signin = False
    return {"ok": st.get("signedIn", False), "browser": st}


@app.post("/api/flow/account-check")
def api_flow_account_check():
    acc = flow_job_manager.browser_manager.verify_account()
    return {"ok": acc.get("verified", False), "account": acc}


@app.post("/api/flow/discover-ui")
def api_flow_discover_ui(body: FlowDiscoverUiInput):
    return flow_job_manager.discover_ui(page_name=body.page)


@app.get("/api/flow/projects")
def api_flow_projects():
    return flow_job_manager.project_navigator.load_projects()


@app.post("/api/flow/disconnect")
def api_flow_disconnect():
    st = flow_job_manager.browser_manager.close()
    return {"ok": True, "browser": st}


@app.post("/api/flow/enqueue")
def api_flow_enqueue(body: FlowEnqueueSceneInput):
    job = flow_job_manager.enqueue_scene(
        project_id=body.project_id,
        scene_id=body.scene_id,
        scene_number=body.scene_number,
        visual_description=body.visual_description,
        image_prompt=body.image_prompt,
        visual_bible=body.visual_bible,
        camera_movement=body.camera_movement,
        model=body.model,
        ratio=body.ratio,
        force=body.force,
    )
    return {"ok": True, "job": _to_dict(job)}


@app.post("/api/flow/enqueue-batch")
def api_flow_enqueue_batch(body: FlowEnqueueBatchInput):
    jobs = []
    for sc in body.scenes:
        job = flow_job_manager.enqueue_scene(
            project_id=body.project_id,
            scene_id=sc.scene_id,
            scene_number=sc.scene_number,
            visual_description=sc.visual_description,
            image_prompt=sc.image_prompt,
            visual_bible=sc.visual_bible or body.visual_bible,
            camera_movement=sc.camera_movement,
            model=sc.model,
            ratio=sc.ratio,
            force=sc.force,
        )
        jobs.append(_to_dict(job))
    return {"ok": True, "jobs": jobs}


@app.post("/api/flow/retry")
def api_flow_retry(body: FlowRetryInput):
    try:
        job = flow_job_manager.retry_scene_job(body.job_id, updated_prompt=body.image_prompt)
        return {"ok": True, "job": _to_dict(job)}
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/api/flow/upload-manual")
def api_flow_upload_manual(body: ManualSceneUploadInput):
    try:
        record = flow_job_manager.upload_manual_scene_image(
            project_id=body.project_id,
            scene_id=body.scene_id,
            scene_number=body.scene_number,
            image_data_url_or_b64=body.image_data_url,
            prompt=body.prompt,
            ratio=body.ratio,
        )
        return {"ok": True, "record": _to_dict(record)}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/flow/versions/{project_id}/{scene_id}")
def api_flow_scene_versions(project_id: str, scene_id: str):
    versions = flow_job_manager.download_manager.list_scene_versions(project_id, scene_id)
    return {"versions": versions}


# ============================================================================
# 5. FFMPEG AUDIO MIXING & MP4 VIDEO RENDERING + FFPROBE VALIDATION ENDPOINTS
# ============================================================================

@app.post("/api/ffmpeg/mix-audio")
def api_ffmpeg_mix_audio(req: FFmpegRenderRequest):
    import tempfile

    total_dur = round(sum(s.duration for s in req.scenes), 2)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            wav_path = build_mixed_audio_wav_with_ffmpeg(req, total_dur, Path(tmp))
            if wav_path is None or not wav_path.exists():
                raise HTTPException(status_code=400, detail="No active voiceover or background music tracks to mix.")
            wav_bytes = wav_path.read_bytes()
            return {
                "ok": True,
                "durationSeconds": total_dur,
                "audioDataUrl": f"data:audio/wav;base64,{base64.b64encode(wav_bytes).decode('ascii')}",
            }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"FFmpeg audio mixing failed: {exc}") from exc


@app.post("/api/ffmpeg/render")
def api_ffmpeg_render(req: FFmpegRenderRequest):
    try:
        mp4_path, validation = render_project_mp4_with_ffmpeg(req)
        mp4_bytes = mp4_path.read_bytes()
        return {
            "ok": True,
            "fileName": mp4_path.name,
            "filePath": str(mp4_path),
            "validation": _to_dict(validation),
            "videoBase64": base64.b64encode(mp4_bytes).decode("ascii"),
        }
    except FFmpegRenderError as r_err:
        return JSONResponse(
            status_code=422,
            content={"ok": False, "error": r_err.message, "details": r_err.details},
        )
    except Exception as exc:
        return JSONResponse(
            status_code=500,
            content={"ok": False, "error": f"FFmpeg video export failed: {exc}"},
        )


if __name__ == "__main__":
    import uvicorn

    VOICES_DIR.mkdir(parents=True, exist_ok=True)
    print("====================================================================")
    print(" AI Cinematic Motivational Video Studio — Local Backend Service")
    print(f" URL:         http://127.0.0.1:{PORT}")
    print(f" Gemini API:  {gemini_service.get_status()['status']}")
    print(f" Google Flow: {flow_job_manager.browser_manager.get_status()['status']}")
    print(f" Piper TTS:   {len(list_voices())} voice model(s) in {VOICES_DIR}")
    print(f" FFmpeg:      {'Ready' if is_ffmpeg_available()['available'] else 'Not found on PATH'}")
    print("====================================================================")
    uvicorn.run(app, host="127.0.0.1", port=PORT)
