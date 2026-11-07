"""Prompt construction and Visual Bible consistency enforcement for Google Flow / Nano Banana."""
from __future__ import annotations

from typing import Any

DEFAULT_PAINTED_ANIME_STYLE = (
    'Retro 1990s lo-fi anime illustration in the style of quiet aesthetic motivational reels: flat matte colors, simple clean line art, soft cel shading, risograph / printed-paper texture with fine film grain and tiny dust specks, muted deep navy and slate-teal skies, dark forest greens, warm burnt-orange and coral sunset accents, low-contrast moody night, dusk, rain or golden-hour light. Either a small lone figure in a vast calm landscape (mountains, lake, forest path, snowy pines, ocean shore, rooftop over night city, empty street under lamps), or an intimate close-up of a young man or woman with a quiet emotional expression. Minimal, uncluttered, cinematic, vertical 9:16, keep the centre band of the frame calm for a caption. No text, no letters, no watermark, no logos, not photorealistic, not 3D.'
)

NEGATIVE_STYLE_CONSTRAINTS = (
    "Strictly avoid: photorealistic rendering, 3D CGI models, plastic-looking skin or surfaces, "
    "unwanted text, subtitles, letters, watermarks, signatures, logos, or inconsistent character outfits."
)


def build_nano_banana_scene_prompt(
    visual_description: str,
    image_prompt: str = "",
    visual_bible: dict[str, Any] | None = None,
    camera_movement: str = "slow zoom in",
    aspect_ratio: str = "9:16",
) -> str:
    """Combines scene description, image prompt, and Visual Bible into a consistent Nano Banana prompt."""
    parts: list[str] = []
    base = image_prompt.strip() or visual_description.strip()
    if base:
        parts.append(base.rstrip("."))

    if visual_bible:
        char_desc = ", ".join(
            f"{k.replace('_', ' ')}: {v}"
            for k, v in visual_bible.items()
            if v and k in ("age_range", "character_appearance", "hair", "clothing", "body_proportions")
        )
        env_desc = ", ".join(
            f"{k.replace('_', ' ')}: {v}"
            for k, v in visual_bible.items()
            if v and k in ("environment", "color_palette", "lighting")
        )
        if env_desc and "color_palette" not in base.lower():
            parts.append(f"Atmosphere & palette ({env_desc})")


    style_str = DEFAULT_PAINTED_ANIME_STYLE.rstrip(".")
    if aspect_ratio == "16:9":
        style_str = style_str.replace("vertical 9:16", "widescreen horizontal 16:9")
    parts.append(style_str)
    parts.append(NEGATIVE_STYLE_CONSTRAINTS)
    return ". ".join(p for p in parts if p)
