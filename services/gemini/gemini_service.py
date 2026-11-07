"""Google Gemini API Service for AI Cinematic Motivational Video Studio.

Compatible with both Pydantic v1 and v2.
All API credentials remain strictly server-side via GEMINI_API_KEY.
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError

DEFAULT_GEMINI_MODEL = "gemini-3.5-flash"

REFERENCE_VISUAL_STYLE = (
    'Retro 1990s lo-fi anime illustration in the style of quiet aesthetic motivational reels: flat matte colors, simple clean line art, soft cel shading, risograph / printed-paper texture with fine film grain and tiny dust specks, muted deep navy and slate-teal skies, dark forest greens, warm burnt-orange and coral sunset accents, low-contrast moody night, dusk, rain or golden-hour light. Either a small lone figure in a vast calm landscape (mountains, lake, forest path, snowy pines, ocean shore, rooftop over night city, empty street under lamps), or an intimate close-up of a young man or woman with a quiet emotional expression. Minimal, uncluttered, cinematic, vertical 9:16, keep the centre band of the frame calm for a caption. No text, no letters, no watermark, no logos, not photorealistic, not 3D.'
)


class GeminiServiceError(Exception):
    def __init__(
        self,
        code: Literal[
            "GEMINI_NOT_CONFIGURED",
            "GEMINI_INVALID_KEY",
            "GEMINI_QUOTA_EXCEEDED",
            "GEMINI_INVALID_RESPONSE",
            "GEMINI_API_ERROR",
        ],
        message: str,
        http_status: int = 400,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status


class VisualBible(BaseModel):
    character_appearance: str = Field(...)
    clothing: str = Field(...)
    hair: str = Field(...)
    age_range: str = Field(...)
    body_proportions: str = Field(...)
    environment: str = Field(...)
    color_palette: str = Field(...)
    lighting: str = Field(...)
    art_style: str = Field(default=REFERENCE_VISUAL_STYLE)

    def to_prompt_prefix(self) -> str:
        return (
            f"Character consistency: {self.age_range}, {self.character_appearance}, "
            f"hair: {self.hair}, wearing {self.clothing}, proportions: {self.body_proportions}. "
            f"Environment & palette: {self.environment}, colors: {self.color_palette}, lighting: {self.lighting}. "
            f"Style: {self.art_style}"
        )


class SceneScriptItem(BaseModel):
    scene_number: int = Field(..., ge=1, le=20)
    start_time: float = Field(..., ge=0.0)
    end_time: float = Field(..., gt=0.0)
    caption: str = Field(..., min_length=2, max_length=160)
    narration: str = Field(default="", max_length=350)
    visual_description: str = Field(..., min_length=10, max_length=800)
    image_prompt: str = Field(..., min_length=10, max_length=2000)
    camera_movement: str = Field(default="slow zoom in")
    transition: str = Field(default="fade")

    @property
    def duration(self) -> float:
        return round(max(1.5, self.end_time - self.start_time), 1)


class ScriptGenerationResponse(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    theme: str = Field(..., min_length=1, max_length=300)
    duration_seconds: int = Field(default=21, ge=9, le=90)
    aspect_ratio: str = Field(default="9:16")
    visual_style: str = Field(default="cinematic painted 2D anime")
    narration: str = Field(default="")
    visual_bible: VisualBible
    scenes: list[SceneScriptItem]

    def normalize(self) -> "ScriptGenerationResponse":
        n = len(self.scenes)
        if n == 0:
            raise ValueError("Script must contain at least one scene.")
        total_target = float(self.duration_seconds)
        raw_durations = [max(1.5, s.end_time - s.start_time) for s in self.scenes]
        raw_sum = sum(raw_durations) or total_target
        scale = total_target / raw_sum

        cursor = 0.0
        bible_prefix = self.visual_bible.to_prompt_prefix()
        for idx, sc in enumerate(self.scenes):
            sc.scene_number = idx + 1
            sc.start_time = round(cursor, 1)
            if idx == n - 1:
                sc.end_time = round(total_target, 1)
            else:
                dur = round(max(2.0, raw_durations[idx] * scale), 1)
                sc.end_time = round(min(total_target - (n - 1 - idx) * 1.5, cursor + dur), 1)
            cursor = sc.end_time

            if not sc.narration.strip():
                sc.narration = sc.caption.strip()

            if "Character consistency:" not in sc.image_prompt:
                sc.image_prompt = (
                    f"{sc.visual_description.rstrip('.')} — {sc.image_prompt.rstrip('.')}. "
                    f"{bible_prefix}"
                )

        if not self.narration.strip():
            self.narration = " ".join(s.narration.strip() for s in self.scenes)
        return self

    def to_dict(self) -> dict[str, Any]:
        if hasattr(self, "model_dump"):
            return self.model_dump()  # type: ignore[attr-defined]
        return self.dict()


class ScriptGenerationRequest(BaseModel):
    title: str = Field(default="", max_length=200)
    category: str = Field(default="Motivation", max_length=100)
    topic: str = Field(..., min_length=1, max_length=500)
    message: str = Field(..., min_length=1, max_length=1000)
    story: str = Field(default="", max_length=1500)
    audience: str = Field(default="General", max_length=200)
    language: str = Field(default="English", max_length=60)
    duration_seconds: int = Field(default=21, ge=9, le=90)
    aspect_ratio: str = Field(default="9:16")
    scene_count: int | None = Field(default=None, ge=3, le=12)
    model: str = Field(default=DEFAULT_GEMINI_MODEL)


def compute_recommended_scene_count(duration_seconds: int, explicit_count: int | None = None) -> int:
    if explicit_count is not None and 3 <= explicit_count <= 12:
        return explicit_count
    # Reference reels: one short spoken phrase per image, about 3 seconds each.
    return max(3, min(12, round(duration_seconds / 3.0)))


class GeminiService:
    def __init__(self, api_key: str | None = None, model: str | None = None) -> None:
        self._api_key = (api_key if api_key is not None else os.environ.get("GEMINI_API_KEY", "")).strip()
        self._model = (model or os.environ.get("GEMINI_MODEL", DEFAULT_GEMINI_MODEL)).strip()

    @property
    def api_key(self) -> str:
        return self._api_key

    @property
    def model(self) -> str:
        return self._model or DEFAULT_GEMINI_MODEL

    def set_credentials(self, api_key: str | None = None, model: str | None = None) -> None:
        if api_key is not None:
            self._api_key = api_key.strip()
            os.environ["GEMINI_API_KEY"] = self._api_key
        if model is not None and model.strip():
            self._model = model.strip()
            os.environ["GEMINI_MODEL"] = self._model

    def get_status(self) -> dict[str, Any]:
        key = self.api_key
        if not key:
            return {
                "status": "not_configured",
                "connected": False,
                "model": self.model,
                "message": "GEMINI_API_KEY is not configured. Set GEMINI_API_KEY in .env or Studio Settings.",
            }
        return {
            "status": "connected",
            "connected": True,
            "model": self.model,
            "message": f"Gemini API configured ({self.model}).",
        }

    def _build_system_prompt(self, req: ScriptGenerationRequest, scene_count: int) -> str:
        avg_sec = round(req.duration_seconds / scene_count, 1)
        return f"""You are a master cinematic motivational film director and visual development artist.
Create a complete, emotionally resonant vertical video script and Visual Bible in {req.language}.

VIDEO SPECIFICATIONS:
- Requested title: {req.title or "(Generate a powerful title)"}
- Category: {req.category}
- Topic: {req.topic}
- Core motivational message: {req.message}
- Story concept: {req.story or "A solitary protagonist persevering through quiet adversity from dusk/rain toward a warm sunrise breakthrough"}
- Target audience: {req.audience or "General audience"}
- Total video duration: {req.duration_seconds} seconds
- Video aspect ratio: {req.aspect_ratio} ({"vertical 9:16" if req.aspect_ratio != "16:9" else "widescreen horizontal 16:9"})
- Exact number of scenes: {scene_count} scenes (~{avg_sec}s per scene)

STYLE: {REFERENCE_VISUAL_STYLE}
Vary shots: wide landscapes with a tiny lone figure, people from behind, emotional close-up portraits. Keep palette, grain and drawing style identical across scenes.

NARRATION FORMAT: one short calm quotable message split into {scene_count} consecutive phrases of 2-8 words. For each scene, caption and narration are the SAME phrase word for word.

Return ONLY valid JSON with: title, theme, duration_seconds, visual_style, narration, visual_bible (character_appearance, clothing, hair, age_range, body_proportions, environment, color_palette, lighting, art_style), and scenes (scene_number, start_time, end_time, caption, narration, visual_description, image_prompt, camera_movement, transition)."""


    def synthesize_speech_wav(
        self,
        text: str,
        voice_id: str = "gemini:clone_reference",
        speed: float = 1.0,
        reference_audio_bytes: bytes | None = None,
        reference_mime_type: str = "audio/mp3",
    ) -> bytes:
        """Synthesizes 24kHz 16-bit mono WAV narration using Google Gemini TTS / Audio generation.

        Supports:
        1. `gemini-2.5-flash-preview-tts` / `gemini-2.0-flash` prebuilt studio voices (`Aoede`, `Kore`, `Charon`, `Fenrir`)
           guided by the cloned voice persona instruction.
        2. Reference-audio voice cloning conditioning when `reference_audio_bytes` is provided.
        """
        import base64
        import io
        import wave

        key = self.api_key
        if not key:
            raise GeminiServiceError(
                "GEMINI_NOT_CONFIGURED",
                "GEMINI_API_KEY is required for Gemini TTS voice cloning. Set GEMINI_API_KEY in .env or Studio Settings.",
                http_status=401,
            )

        voice_meta = next((v for v in GEMINI_TTS_VOICES if v["id"] == voice_id), GEMINI_TTS_VOICES[0])
        gemini_voice_name = voice_meta.get("geminiVoiceName", "Charon")
        is_clone = voice_id in ("gemini:clone_whayrs_male", "gemini:clone_reference") or bool(reference_audio_bytes)
        style_prompt = (
            CLONED_VOICE_STYLE_PROMPT_MALE
            if voice_meta.get("gender") == "male"
            else CLONED_VOICE_STYLE_PROMPT_FEMALE
        )

        tts_models = ["gemini-2.5-flash-preview-tts", "gemini-2.0-flash-exp", "gemini-2.0-flash"]
        pcm_or_wav_bytes: bytes | None = None
        mime_returned: str = ""
        last_err: str = ""

        for tts_model in tts_models:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{tts_model}:generateContent?key={key}"
            parts: list[dict[str, Any]] = []
            if is_clone and reference_audio_bytes and "tts" not in tts_model:
                # Multimodal audio-in -> audio-out voice cloning conditioning
                parts.append({
                    "inlineData": {
                        "mimeType": reference_mime_type,
                        "data": base64.b64encode(reference_audio_bytes).decode("ascii"),
                    }
                })
                parts.append({
                    "text": (
                        f"{CLONED_VOICE_STYLE_PROMPT}\n"
                        f"Match the speaker voice in the reference audio clip above and read the following line "
                        f"verbatim (output ONLY spoken audio of the exact words, no extra commentary):\n{text}"
                    )
                })
            elif "tts" in tts_model:
                # Dedicated Gemini TTS model expects the text or style-prefixed text
                parts.append({"text": f"{style_prompt} Say: {text}" if is_clone else text})
            else:
                parts.append({
                    "text": (
                        f"{CLONED_VOICE_STYLE_PROMPT}\n"
                        f"Read the following line aloud verbatim (output ONLY the spoken words):\n{text}"
                    )
                })

            payload: dict[str, Any] = {
                "contents": [{"role": "user", "parts": parts}],
                "generationConfig": {
                    "responseModalities": ["AUDIO"],
                    "speechConfig": {
                        "voiceConfig": {
                            "prebuiltVoiceConfig": {
                                "voiceName": gemini_voice_name,
                            }
                        }
                    },
                },
            }

            req_obj = urllib.request.Request(
                url,
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(req_obj, timeout=45) as resp:
                    body = json.loads(resp.read().decode("utf-8"))
                candidates = body.get("candidates") or []
                for cand in candidates:
                    for part in (cand.get("content") or {}).get("parts") or []:
                        inline = part.get("inlineData") or part.get("inline_data")
                        if inline and inline.get("data"):
                            pcm_or_wav_bytes = base64.b64decode(inline["data"])
                            mime_returned = (inline.get("mimeType") or inline.get("mime_type") or "").lower()
                            break
                    if pcm_or_wav_bytes:
                        break
                if pcm_or_wav_bytes:
                    break
            except urllib.error.HTTPError as http_err:
                err_body = http_err.read().decode("utf-8", errors="replace")
                if http_err.code in (401, 403, 429):
                    self._handle_http_error(http_err.code, err_body)
                last_err = f"HTTP {http_err.code}: {err_body[:200]}"
                continue
            except Exception as exc:
                last_err = str(exc)
                continue

        if not pcm_or_wav_bytes:
            raise GeminiServiceError(
                "GEMINI_API_ERROR",
                f"Gemini TTS synthesis failed ({last_err or 'no audio returned'}). Check your GEMINI_API_KEY.",
                http_status=502,
            )

        # If Gemini returned a WAV header already, return it directly; otherwise wrap raw 24kHz 16-bit mono PCM in WAV
        if pcm_or_wav_bytes[:4] == b"RIFF" and pcm_or_wav_bytes[8:12] == b"WAVE":
            raw_wav = pcm_or_wav_bytes
        else:
            sample_rate = 24000
            if "rate=" in mime_returned:
                try:
                    rate_str = mime_returned.split("rate=")[1].split(";")[0].strip()
                    sample_rate = int(rate_str)
                except Exception:
                    sample_rate = 24000
            buf = io.BytesIO()
            with wave.open(buf, "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(sample_rate)
                wf.writeframes(pcm_or_wav_bytes)
            raw_wav = buf.getvalue()

        return raw_wav

    def generate_motivational_script(self, req: ScriptGenerationRequest) -> ScriptGenerationResponse:
        key = self.api_key
        if not key:
            raise GeminiServiceError(
                "GEMINI_NOT_CONFIGURED",
                "GEMINI_API_KEY is not configured. Please set GEMINI_API_KEY in your environment or Studio Settings.",
                http_status=401,
            )

        scene_count = compute_recommended_scene_count(req.duration_seconds, req.scene_count)
        model_name = (req.model or self.model or DEFAULT_GEMINI_MODEL).strip()
        prompt_text = self._build_system_prompt(req, scene_count)

        candidate_models = list(
            dict.fromkeys(
                [
                    model_name,
                    "gemini-3.8-flash",
                    "gemini-flash-latest",
                ]
            )
        )
        last_error: GeminiServiceError | None = None
        for index, candidate_model in enumerate(candidate_models):
            try:
                raw_json_text = self._call_gemini_json(
                    api_key=key,
                    model_name=candidate_model,
                    prompt=prompt_text,
                )
                return self.parse_and_validate_script_json(
                    raw_json_text,
                    expected_duration=req.duration_seconds,
                )
            except GeminiServiceError as exc:
                last_error = exc
                if index == len(candidate_models) - 1 or not self._is_transient_model_error(exc):
                    raise
                print(
                    f"Gemini model {candidate_model} is temporarily unavailable; "
                    f"retrying with {candidate_models[index + 1]}."
                )
                time.sleep(0.5)
        raise last_error or GeminiServiceError(
            "GEMINI_API_ERROR",
            "Gemini script generation failed without a response.",
            http_status=502,
        )

    @staticmethod
    def _is_transient_model_error(error: GeminiServiceError) -> bool:
        message = error.message.lower()
        return error.code == "GEMINI_API_ERROR" and any(
            marker in message
            for marker in (
                "503",
                "service unavailable",
                "temporarily unavailable",
                "high demand",
                "overloaded",
                "deadline exceeded",
                "timed out",
                "no longer available",
                "not found",
            )
        )

    def _call_gemini_json(self, api_key: str, model_name: str, prompt: str) -> str:
        try:
            from google import genai  # type: ignore[import-not-found]
            from google.genai import types  # type: ignore[import-not-found]

            client = genai.Client(api_key=api_key)
            resp = client.models.generate_content(
                model=model_name,
                contents=prompt,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    temperature=0.7,
                ),
            )
            if not resp or not resp.text:
                raise GeminiServiceError(
                    "GEMINI_INVALID_RESPONSE",
                    "Gemini API returned an empty response.",
                    http_status=502,
                )
            return resp.text
        except ImportError:
            pass
        except GeminiServiceError:
            raise
        except Exception as exc:
            self._raise_classified_exception(exc)

        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={api_key}"
        payload = {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {
                "responseMimeType": "application/json",
                "temperature": 0.7,
            },
        }
        req_obj = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req_obj, timeout=45) as response:
                body = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as http_err:
            err_body = http_err.read().decode("utf-8", errors="replace")
            self._handle_http_error(http_err.code, err_body)
        except Exception as exc:
            raise GeminiServiceError(
                "GEMINI_API_ERROR",
                f"Failed to reach Google Gemini API: {exc}",
                http_status=502,
            ) from exc

        try:
            candidates = body.get("candidates") or []
            parts = candidates[0]["content"]["parts"]
            text = "".join(p.get("text", "") for p in parts).strip()
            if not text:
                raise ValueError("Empty text in Gemini candidate")
            return text
        except Exception as exc:
            raise GeminiServiceError(
                "GEMINI_INVALID_RESPONSE",
                f"Gemini returned an unexpected payload structure: {exc}",
                http_status=502,
            ) from exc

    def _handle_http_error(self, status_code: int, err_body: str) -> None:
        lower = err_body.lower()
        if status_code in (401, 403) or "api_key_invalid" in lower or "api key not valid" in lower:
            raise GeminiServiceError(
                "GEMINI_INVALID_KEY",
                "Invalid Gemini API key. Check your GEMINI_API_KEY in .env or Studio Settings.",
                http_status=401,
            )
        if status_code == 429 or "quota" in lower or "resource_exhausted" in lower:
            raise GeminiServiceError(
                "GEMINI_QUOTA_EXCEEDED",
                "Gemini API quota or rate limit exceeded. Wait a moment or check your Google AI Studio billing/quota.",
                http_status=429,
            )
        raise GeminiServiceError(
            "GEMINI_API_ERROR",
            f"Gemini API error (HTTP {status_code}): {err_body[:300]}",
            http_status=status_code if 400 <= status_code < 600 else 502,
        )

    def _raise_classified_exception(self, exc: Exception) -> None:
        msg = str(exc)
        lower = msg.lower()
        if "api_key_invalid" in lower or "api key not valid" in lower or "401" in lower or "403" in lower:
            raise GeminiServiceError(
                "GEMINI_INVALID_KEY",
                "Invalid Gemini API key. Check your GEMINI_API_KEY.",
                http_status=401,
            ) from exc
        if "429" in lower or "quota" in lower or "resource_exhausted" in lower:
            raise GeminiServiceError(
                "GEMINI_QUOTA_EXCEEDED",
                "Gemini API quota exceeded. Please wait or check your quota limits.",
                http_status=429,
            ) from exc
        raise GeminiServiceError(
            "GEMINI_API_ERROR",
            f"Gemini API request failed: {msg}",
            http_status=502,
        ) from exc

    @staticmethod
    def parse_and_validate_script_json(raw_text: str, expected_duration: int = 21) -> ScriptGenerationResponse:
        cleaned = raw_text.strip()
        if cleaned.startswith("```"):
            lines = cleaned.splitlines()
            if lines and lines[0].startswith("```"):
                lines = lines[1:]
            if lines and lines[-1].strip().startswith("```"):
                lines = lines[:-1]
            cleaned = "\n".join(lines).strip()

        try:
            data = json.loads(cleaned)
        except Exception as exc:
            raise GeminiServiceError(
                "GEMINI_INVALID_RESPONSE",
                f"Gemini response was not valid JSON: {exc}",
                http_status=502,
            ) from exc

        if not isinstance(data, dict):
            raise GeminiServiceError(
                "GEMINI_INVALID_RESPONSE",
                "Gemini JSON response must be a JSON object.",
                http_status=502,
            )

        if "duration_seconds" not in data or not data["duration_seconds"]:
            data["duration_seconds"] = expected_duration
        if isinstance(data.get("narration"), list):
            data["narration"] = " ".join(str(part).strip() for part in data["narration"] if str(part).strip())
        if isinstance(data.get("scenes"), list):
            for scene in data["scenes"]:
                if isinstance(scene, dict) and isinstance(scene.get("narration"), list):
                    scene["narration"] = " ".join(
                        str(part).strip() for part in scene["narration"] if str(part).strip()
                    )

        try:
            if hasattr(ScriptGenerationResponse, "model_validate"):
                parsed = ScriptGenerationResponse.model_validate(data)  # type: ignore[attr-defined]
            else:
                parsed = ScriptGenerationResponse.parse_obj(data)
            if len(parsed.scenes) < 3:
                raise ValueError("Script must contain at least 3 scenes.")
            return parsed.normalize()
        except (ValidationError, ValueError) as val_err:
            raise GeminiServiceError(
                "GEMINI_INVALID_RESPONSE",
                f"Gemini response failed schema validation: {val_err}",
                http_status=502,
            ) from val_err


GEMINI_TTS_VOICES: list[dict[str, Any]] = [
    {
        "id": "gemini:clone_whayrs_male",
        "name": "Cloned Video Voice (@W.hayrs Warm British Male — Gemini TTS)",
        "speaker": "Cloned Video Voice (@W.hayrs Male)",
        "language": "en_GB",
        "languageName": "English (United Kingdom)",
        "quality": "studio-clone",
        "gender": "male",
        "engine": "gemini",
        "geminiVoiceName": "Charon",
        "referenceFile": "reference_whayrs_male.mp3",
        "fallbackPiper": "en_GB-alan-medium",
        "sampleRate": 24000,
        "description": (
            "Cloned from your 4 uploaded @W.hayrs reference reels ('A yes from God blesses you...', "
            "'The hardest battle in life...'): warm, soft-spoken, intimate British male narrator with calm reflective pauses."
        ),
    },
    {
        "id": "gemini:clone_reference",
        "name": "Cloned Audio Voice ('Words Hold Power' Calm Female — Gemini TTS)",
        "speaker": "Cloned Reference Voice (Female)",
        "language": "en_US",
        "languageName": "English (United States)",
        "quality": "studio-clone",
        "gender": "female",
        "engine": "gemini",
        "geminiVoiceName": "Aoede",
        "referenceFile": "reference_calm_female.mp3",
        "fallbackPiper": "en_US-amy-medium",
        "sampleRate": 24000,
        "description": (
            "Cloned from your uploaded motivational MP3 ('Words hold power...'): "
            "warm, intimate, unhurried, deeply reflective American female delivery via Gemini TTS."
        ),
    },
    {
        "id": "gemini:aoede",
        "name": "Aoede (Gemini Studio — Warm Reflective Female)",
        "speaker": "Aoede",
        "language": "en_US",
        "languageName": "English (United States)",
        "quality": "studio",
        "gender": "female",
        "engine": "gemini",
        "geminiVoiceName": "Aoede",
        "sampleRate": 24000,
        "description": "Warm, calm, intimate female storyteller voice powered by Gemini TTS.",
    },
    {
        "id": "gemini:kore",
        "name": "Kore (Gemini Studio — Soothing Poetic Female)",
        "speaker": "Kore",
        "language": "en_US",
        "languageName": "English (United States)",
        "quality": "studio",
        "gender": "female",
        "engine": "gemini",
        "geminiVoiceName": "Kore",
        "sampleRate": 24000,
        "description": "Soft, serene, meditative female narration voice powered by Gemini TTS.",
    },
    {
        "id": "gemini:charon",
        "name": "Charon (Gemini Studio — Deep Cinematic Male)",
        "speaker": "Charon",
        "language": "en_US",
        "languageName": "English (United States)",
        "quality": "studio",
        "gender": "male",
        "engine": "gemini",
        "geminiVoiceName": "Charon",
        "sampleRate": 24000,
        "description": "Deep, grounded, cinematic male narrator powered by Gemini TTS.",
    },
    {
        "id": "gemini:fenrir",
        "name": "Fenrir (Gemini Studio — Earnest Motivational Male)",
        "speaker": "Fenrir",
        "language": "en_US",
        "languageName": "English (United States)",
        "quality": "studio",
        "gender": "male",
        "engine": "gemini",
        "geminiVoiceName": "Fenrir",
        "sampleRate": 24000,
        "description": "Resonant, inspiring male voice powered by Gemini TTS.",
    },
]

CLONED_VOICE_STYLE_PROMPT_FEMALE = (
    "Speak with the exact vocal persona, pacing, and emotional intimacy of the reference narrator: "
    "a calm, warm, soft-spoken, deeply reflective young woman with a gentle American accent, "
    "deliberate pauses between phrases, quiet wisdom, and soothing motivational resonance."
)

CLONED_VOICE_STYLE_PROMPT_MALE = (
    "Speak with the exact vocal persona, pacing, and emotional intimacy of the @W.hayrs reference reel narrator: "
    "a calm, warm, soft-spoken, deeply reflective British male voice with gentle baritone resonance, "
    "measured pauses between short phrases, and quiet cinematic sincerity."
)

CLONED_VOICE_STYLE_PROMPT = CLONED_VOICE_STYLE_PROMPT_MALE
