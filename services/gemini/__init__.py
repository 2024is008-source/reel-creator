"""Google Gemini API & Gemini TTS Voice Cloning Service Package."""
from .gemini_service import (
    CLONED_VOICE_STYLE_PROMPT,
    DEFAULT_GEMINI_MODEL,
    GEMINI_TTS_VOICES,
    GeminiService,
    GeminiServiceError,
    SceneScriptItem,
    ScriptGenerationRequest,
    ScriptGenerationResponse,
    VisualBible,
    compute_recommended_scene_count,
)

__all__ = [
    "CLONED_VOICE_STYLE_PROMPT",
    "DEFAULT_GEMINI_MODEL",
    "GEMINI_TTS_VOICES",
    "GeminiService",
    "GeminiServiceError",
    "SceneScriptItem",
    "ScriptGenerationRequest",
    "ScriptGenerationResponse",
    "VisualBible",
    "compute_recommended_scene_count",
]
