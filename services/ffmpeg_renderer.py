"""FFmpeg Audio Mixing, 1080x1920 30FPS H.264/AAC Video Rendering, and FFprobe Validation Service.

Final video specifications enforced:
- Resolution: 1080 x 1920
- Aspect ratio: 9:16
- Frame rate: 30 FPS
- Video codec: H.264 (libx264)
- Audio codec: AAC (192 kbps, 44.1 kHz stereo)
- Container: MP4
- Pixel format: yuv420p
- Fast start enabled (-movflags +faststart)
- Validated after every render using ffprobe
"""
from __future__ import annotations

import base64
import io
import json
import math
import os
import shutil
import subprocess
import tempfile
import threading
import wave
from pathlib import Path
from typing import Any, Literal

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from pydantic import BaseModel, Field

W = 1080
H = 1920
FPS = 30
FADE_SEC = 0.6
VOICE_DELAY = 0.25


def dump_model(m: BaseModel) -> dict[str, Any]:
    if hasattr(m, "model_dump"):
        return m.model_dump()  # type: ignore[attr-defined]
    return m.dict()


class RenderSceneInput(BaseModel):
    id: str
    scene_number: int = 1
    caption: str = ""
    narration: str = ""
    visual: str = ""
    duration: float = Field(default=3.5, ge=1.0, le=30.0)
    camera_movement: str = "slow zoom in"
    transition: str = "fade"
    image_data_url: str | None = None
    voice_data_url: str | None = None
    voice_duration: float | None = None


class FFmpegRenderRequest(BaseModel):
    project_id: str
    title: str = "Motivational_Video"
    aspect_ratio: Literal["9:16", "16:9"] = "9:16"
    scenes: list[RenderSceneInput]
    music_data_url: str | None = None
    music_format: str = "mp3"
    voice_volume: float = Field(default=100.0, ge=0.0, le=150.0)
    music_volume: float = Field(default=18.0, ge=0.0, le=100.0)
    music_fade_in: float = Field(default=1.5, ge=0.0, le=10.0)
    music_fade_out: float = Field(default=2.0, ge=0.0, le=10.0)
    music_start_offset: float = Field(default=0.0, ge=0.0)
    short_track_behavior: Literal["loop", "change", "none"] = "loop"
    ducking_enabled: bool = True
    ducking_level: float = Field(default=10.0, ge=5.0, le=20.0)
    export_audio_mode: Literal["both", "voice", "music", "none"] = "both"
    watermark: str = ""


class FFprobeValidationResult(BaseModel):
    valid: bool
    container_format: str
    video_codec: str
    pixel_format: str
    width: int
    height: int
    aspect_ratio: str
    fps: float
    audio_codec: str | None = None
    audio_channels: int | None = None
    duration_seconds: float
    expected_duration_seconds: float
    faststart_verified: bool
    file_size_bytes: int
    errors: list[str] = Field(default_factory=list)


class FFmpegRenderError(Exception):
    def __init__(self, message: str, details: str = "") -> None:
        super().__init__(message)
        self.message = message
        self.details = details


def is_ffmpeg_available() -> dict[str, Any]:
    ffmpeg_bin = shutil.which("ffmpeg")
    ffprobe_bin = shutil.which("ffprobe")
    return {
        "available": bool(ffmpeg_bin and ffprobe_bin),
        "ffmpegPath": ffmpeg_bin,
        "ffprobePath": ffprobe_bin,
    }


def _decode_data_url(data_url: str) -> bytes:
    comma = data_url.find(",")
    b64 = data_url[comma + 1 :] if comma >= 0 else data_url
    return base64.b64decode(b64)


def _load_caption_font(size: int = 54) -> Any:
    fonts_dir = Path(__file__).resolve().parent.parent / "local-tts" / "fonts"
    candidates = [
        str(fonts_dir / "Kalam-Regular.ttf"),  # same handwritten font as the in-browser preview
        "C:\\Windows\\Fonts\\segoepr.ttf",  # Segoe Print fallback (handwritten look)
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
        "C:\\Windows\\Fonts\\segoeui.ttf",
        "C:\\Windows\\Fonts\\arialbd.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size=size)
            except Exception:
                pass
    return ImageFont.load_default()



def _split_caption_into_phrases(caption: str) -> list[str]:
    """Splits a scene caption into 1 or 2 short sequential sub-phrases matching the @W.hayrs reference reels
    (e.g. 'A yes from God' -> 'blesses you', 'The hardest battle in life is fighting yourself').
    """
    clean = " ".join(caption.strip().split())
    if not clean:
        return []
    if "|" in clean:
        parts = [p.strip() for p in clean.split("|") if p.strip()]
        if len(parts) >= 2:
            return parts[:2]
    if "," in clean:
        idx = clean.find(",")
        left = clean[:idx].strip()
        right = clean[idx + 1 :].strip()
        if len(left.split()) >= 2 and len(right.split()) >= 2:
            return [left, right]
    words = clean.split()
    if len(words) >= 8:
        # Look for natural conjunction split near the middle
        mid = len(words) // 2
        for offset in (0, -1, 1, -2, 2):
            pos = mid + offset
            if 2 <= pos <= len(words) - 2 and words[pos].lower() in (
                "when", "because", "and", "but", "that", "to", "is", "will", "into", "before"
            ):
                return [" ".join(words[:pos]), " ".join(words[pos:])]
    return [clean]


def _draw_film_dust_specks(draw: ImageDraw.ImageDraw, t: float, target_w: int, target_h: int) -> None:
    """Draws authentic @W.hayrs retro film dust specks and occasional subtle vertical print scratches at ~8 Hz."""
    tick = int(math.floor(t * 8.0))
    for i in range(7):
        r = math.sin((tick * 31 + i) * 12.9898) * 43758.5453
        r = r - math.floor(r)
        if r < 0.45:
            continue
        rx = math.sin((tick * 17 + i * 3) * 12.9898) * 43758.5453
        rx = rx - math.floor(rx)
        ry = math.sin((tick * 13 + i * 7) * 12.9898) * 43758.5453
        ry = ry - math.floor(ry)
        rs = math.sin((tick + i * 11) * 12.9898) * 43758.5453
        rs = rs - math.floor(rs)
        x = int(rx * target_w)
        y = int(ry * target_h)
        size = int(2 + rs * 5)
        is_dark = ((tick + i) % 2) == 0
        col = (12, 12, 14, 145) if is_dark else (240, 235, 225, 90)
        draw.ellipse([(x - size, y - max(1, size // 2)), (x + size, y + max(1, size // 2))], fill=col)


def _wrap_caption_text(draw: ImageDraw.ImageDraw, text: str, font: Any, max_width: int) -> list[str]:
    words = text.strip().split()
    if not words:
        return []
    lines: list[str] = []
    cur = ""
    for w in words:
        cand = f"{cur} {w}".strip() if cur else w
        bbox = draw.textbbox((0, 0), cand, font=font)
        if (bbox[2] - bbox[0]) > max_width and cur:
            lines.append(cur)
            cur = w
        else:
            cur = cand
    if cur:
        lines.append(cur)
    return lines


def get_target_dimensions(aspect_ratio: str = "9:16") -> tuple[int, int]:
    if aspect_ratio == "16:9":
        return 1920, 1080
    return 1080, 1920


def _prepare_scene_image(scene: RenderSceneInput, target_w: int = W, target_h: int = H) -> Image.Image:
    if not scene.image_data_url:
        raise FFmpegRenderError(
            f"Scene {scene.scene_number} ('{scene.caption[:30]}') does not have a generated or uploaded image yet."
        )
    raw = _decode_data_url(scene.image_data_url)
    with Image.open(io.BytesIO(raw)) as im:
        rgb = im.convert("RGB")
        w, h = rgb.size
        src_ratio = w / max(1, h)
        dst_ratio = target_w / max(1, target_h)
        if abs(src_ratio - dst_ratio) > 0.03:
            if src_ratio > dst_ratio:
                new_w = int(h * dst_ratio)
                left = (w - new_w) // 2
                rgb = rgb.crop((left, 0, left + new_w, h))
            else:
                new_h = int(w / dst_ratio)
                top = (h - new_h) // 2
                rgb = rgb.crop((0, top, w, top + new_h))
        return rgb.resize((target_w, target_h), Image.Resampling.LANCZOS)


def _create_vignette_mask(target_w: int = W, target_h: int = H) -> np.ndarray:
    y = np.linspace(-1.0, 1.0, target_h, dtype=np.float32)[:, None]
    x = np.linspace(-1.0, 1.0, target_w, dtype=np.float32)[None, :]
    r = np.sqrt(x * x + y * y)
    mask = np.clip(1.0 - 0.35 * np.clip((r - 0.45) / 0.95, 0.0, 1.0) ** 1.6, 0.55, 1.0)
    return mask[:, :, None]


def _render_frame_rgb(
    t: float,
    total_dur: float,
    scenes: list[RenderSceneInput],
    scene_imgs: list[Image.Image],
    vignette: np.ndarray,
    font: Any,
    rng: np.random.Generator,
    watermark: str = "",
    mark_font: Any = None,
    target_w: int = W,
    target_h: int = H,
) -> bytes:
    base_canvas = Image.new("RGB", (target_w, target_h), (11, 13, 16))
    start = 0.0

    for idx, sc in enumerate(scenes):
        end = start + sc.duration
        local = t - start
        is_last = idx == len(scenes) - 1
        if start <= t < end or (is_last and t >= end):
            p = min(max(local / max(0.1, sc.duration), 0.0), 1.0)
            zoom = 1.0 + 0.035 * p
            crop_w = int(target_w / zoom)
            crop_h = int(target_h / zoom)
            cx = (target_w - crop_w) // 2
            cy = (target_h - crop_h) // 2
            base_canvas = scene_imgs[idx].crop((cx, cy, cx + crop_w, cy + crop_h)).resize(
                (target_w, target_h), Image.Resampling.BILINEAR
            )
        start = end

    arr = np.asarray(base_canvas, dtype=np.float32) * vignette
    grain_tile = rng.integers(-6, 7, size=(target_h // 4, target_w // 4, 1), dtype=np.int16)
    grain_full = np.repeat(np.repeat(grain_tile, 4, axis=0), 4, axis=1)[:target_h, :target_w, :]
    arr = np.clip(arr + grain_full, 0, 255).astype(np.uint8)
    frame_img = Image.fromarray(arr, mode="RGB")

    overlay = Image.new("RGBA", (target_w, target_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    _draw_film_dust_specks(draw, t, target_w, target_h)

    start = 0.0
    for sc in scenes:
        local = t - start
        if 0.0 <= local < sc.duration and sc.caption.strip():
            phrases = _split_caption_into_phrases(sc.caption)
            n_phr = max(1, len(phrases))
            phr_dur = sc.duration / float(n_phr)
            phr_idx = min(n_phr - 1, int(local / max(0.01, phr_dur)))
            phr_local = local - phr_idx * phr_dur
            active_phrase = phrases[phr_idx]

            cap_alpha = min(1.0, phr_local / 0.18, (phr_dur - phr_local) / 0.18)
            cap_alpha = max(0.0, min(1.0, cap_alpha))
            if cap_alpha > 0.02:
                lines = _wrap_caption_text(draw, active_phrase, font, int(target_w * 0.74))
                line_h = 60
                y_center = int(target_h * 0.5)
                for line_i, line in enumerate(lines):
                    y_pos = int(y_center + (line_i - (len(lines) - 1) / 2.0) * line_h)
                    bbox = draw.textbbox((0, 0), line, font=font)
                    tw = bbox[2] - bbox[0]
                    x_pos = (target_w - tw) // 2
                    shadow_a = int(185 * cap_alpha)
                    draw.text((x_pos + 2, y_pos + 3), line, font=font, fill=(0, 0, 0, shadow_a))
                    text_a = int(255 * cap_alpha)
                    draw.text((x_pos, y_pos), line, font=font, fill=(247, 245, 239, text_a))
            break
        start += sc.duration

    mark = (watermark or "@W.hayrs").strip()
    if mark and mark_font is not None:
        mark = mark if mark.startswith("@") else f"@{mark}"
        bbox = draw.textbbox((0, 0), mark, font=mark_font)
        x_pos = (target_w - (bbox[2] - bbox[0])) // 2
        y_pos = int(target_h * 0.815) - (bbox[3] - bbox[1]) // 2
        draw.text((x_pos + 1, y_pos + 2), mark, font=mark_font, fill=(0, 0, 0, 145))
        draw.text((x_pos, y_pos), mark, font=mark_font, fill=(242, 239, 232, 220))

    frame_img = Image.alpha_composite(frame_img.convert("RGBA"), overlay).convert("RGB")

    # Exact 0.6s fade-to-black at the end of the reel matching @W.hayrs videos
    if t > total_dur - 0.6:
        fade_out_p = max(0.0, min(1.0, (total_dur - t) / 0.6))
        if fade_out_p < 0.999:
            black = Image.new("RGB", (target_w, target_h), (0, 0, 0))
            frame_img = Image.blend(black, frame_img, fade_out_p)

    return frame_img.tobytes()


def build_mixed_audio_wav_with_ffmpeg(
    req: FFmpegRenderRequest,
    total_duration: float,
    work_dir: Path,
) -> Path | None:
    mode = req.export_audio_mode
    if mode == "none":
        return None

    sr = 44100
    total_samples = int(math.ceil(total_duration * sr))

    allow_voice = mode in ("both", "voice") and req.voice_volume > 0
    speech_intervals: list[tuple[float, float]] = []
    voice_master_wav = work_dir / "voice_timeline.wav"
    voice_pcm = np.zeros(total_samples, dtype=np.float32)
    has_voice = False

    if allow_voice:
        scene_cursor = 0.0
        vol_scale = float(req.voice_volume) / 100.0

        for idx, sc in enumerate(req.scenes):
            if sc.voice_data_url:
                raw_wav = _decode_data_url(sc.voice_data_url)
                sc_wav_path = work_dir / f"sc_voice_{idx}.wav"
                sc_pcm_path = work_dir / f"sc_voice_{idx}.raw"
                sc_wav_path.write_bytes(raw_wav)
                subprocess.run(
                    [
                        "ffmpeg",
                        "-y",
                        "-i",
                        str(sc_wav_path),
                        "-f",
                        "s16le",
                        "-acodec",
                        "pcm_s16le",
                        "-ac",
                        "1",
                        "-ar",
                        str(sr),
                        str(sc_pcm_path),
                    ],
                    capture_output=True,
                    check=True,
                )
                pcm_bytes = sc_pcm_path.read_bytes()
                samples = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
                if samples.size > 0:
                    has_voice = True
                    start_t = scene_cursor + VOICE_DELAY
                    dur_t = min(sc.duration - VOICE_DELAY, samples.size / sr)
                    if dur_t > 0.05:
                        speech_intervals.append((start_t, start_t + dur_t))
                    start_idx = int(start_t * sr)
                    end_idx = min(total_samples, start_idx + samples.size)
                    if end_idx > start_idx:
                        voice_pcm[start_idx:end_idx] += samples[: end_idx - start_idx] * vol_scale
            scene_cursor += sc.duration

        if has_voice:
            clipped = np.clip(voice_pcm * 32767.0, -32768, 32767).astype(np.int16)
            with wave.open(str(voice_master_wav), "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(sr)
                wf.writeframes(clipped.tobytes())

    allow_music = mode in ("both", "music") and bool(req.music_data_url) and req.music_volume > 0
    music_pcm = np.zeros(total_samples, dtype=np.float32)
    has_music = False

    if allow_music and req.music_data_url:
        ext = (req.music_format or "mp3").lower().strip(".")
        if ext not in ("mp3", "wav", "m4a"):
            ext = "mp3"
        raw_music_path = work_dir / f"uploaded_music.{ext}"
        raw_music_path.write_bytes(_decode_data_url(req.music_data_url))

        probe = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(raw_music_path),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        try:
            music_dur = float(probe.stdout.strip())
        except Exception:
            music_dur = total_duration

        is_short = music_dur + 0.05 < total_duration
        if is_short and req.short_track_behavior == "none":
            allow_music = False
        else:
            decoded_music_raw = work_dir / "music_decoded.raw"
            ff_cmd = ["ffmpeg", "-y"]
            if not is_short or req.short_track_behavior == "loop":
                ff_cmd += ["-stream_loop", "-1"]
            if req.music_start_offset > 0 and not is_short:
                ff_cmd += ["-ss", f"{req.music_start_offset:.2f}"]
            ff_cmd += [
                "-i",
                str(raw_music_path),
                "-t",
                f"{total_duration:.3f}",
                "-f",
                "s16le",
                "-acodec",
                "pcm_s16le",
                "-ac",
                "1",
                "-ar",
                str(sr),
                str(decoded_music_raw),
            ]
            subprocess.run(ff_cmd, capture_output=True, check=True)
            m_bytes = decoded_music_raw.read_bytes()
            m_samples = np.frombuffer(m_bytes, dtype=np.int16).astype(np.float32) / 32768.0
            if m_samples.size > 0:
                has_music = True
                n_copy = min(total_samples, m_samples.size)
                music_pcm[:n_copy] = m_samples[:n_copy]

                t_grid = np.linspace(0.0, total_duration, total_samples, dtype=np.float32)
                normal_vol = float(req.music_volume) / 100.0
                env = np.full(total_samples, normal_vol, dtype=np.float32)

                fade_in = max(0.0, min(total_duration * 0.45, float(req.music_fade_in)))
                fade_out = max(0.0, min(total_duration * 0.45, float(req.music_fade_out)))
                if fade_in > 0.01:
                    fi_mask = t_grid < fade_in
                    env[fi_mask] *= t_grid[fi_mask] / fade_in
                if fade_out > 0.01:
                    fo_mask = t_grid > (total_duration - fade_out)
                    env[fo_mask] *= np.clip((total_duration - t_grid[fo_mask]) / fade_out, 0.0, 1.0)

                if req.ducking_enabled and has_voice and speech_intervals:
                    target_duck = max(0.08, min(0.12, float(req.ducking_level) / 100.0))
                    ducked_vol = target_duck if normal_vol > target_duck else normal_vol * 0.55
                    duck_ratio = (ducked_vol / normal_vol) if normal_vol > 0 else 1.0
                    attack = 0.18
                    release = 0.40
                    duck_env = np.ones(total_samples, dtype=np.float32)
                    for iv_start, iv_end in speech_intervals:
                        active_mask = (t_grid >= iv_start) & (t_grid <= iv_end)
                        duck_env[active_mask] = np.minimum(duck_env[active_mask], duck_ratio)

                        att_mask = (t_grid >= iv_start - attack) & (t_grid < iv_start)
                        if np.any(att_mask):
                            prog = (t_grid[att_mask] - (iv_start - attack)) / attack
                            duck_env[att_mask] = np.minimum(
                                duck_env[att_mask], 1.0 - prog * (1.0 - duck_ratio)
                            )

                        rel_mask = (t_grid > iv_end) & (t_grid <= iv_end + release)
                        if np.any(rel_mask):
                            prog = (t_grid[rel_mask] - iv_end) / release
                            duck_env[rel_mask] = np.minimum(
                                duck_env[rel_mask], duck_ratio + prog * (1.0 - duck_ratio)
                            )
                    env *= duck_env

                music_pcm *= env

    if not has_voice and not has_music:
        return None

    raw_mix = np.zeros(total_samples, dtype=np.float32)
    if has_voice:
        raw_mix += voice_pcm
    if has_music:
        raw_mix += music_pcm

    pre_limit_wav = work_dir / "pre_limit_mix.wav"
    clipped_pre = np.clip(raw_mix * 32767.0, -32768, 32767).astype(np.int16)
    with wave.open(str(pre_limit_wav), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(clipped_pre.tobytes())

    final_mix_wav = work_dir / "final_mixed_audio.wav"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(pre_limit_wav),
            "-af",
            "alimiter=limit=0.95:attack=5:release=50,pan=stereo|c0=c0|c1=c0",
            "-ar",
            "44100",
            "-ac",
            "2",
            str(final_mix_wav),
        ],
        capture_output=True,
        check=True,
    )
    return final_mix_wav


def validate_video_with_ffprobe(
    mp4_path: Path,
    expected_duration: float,
    expect_audio: bool,
    expected_aspect_ratio: str = "9:16",
) -> FFprobeValidationResult:
    if not mp4_path.exists() or mp4_path.stat().st_size == 0:
        raise FFmpegRenderError("Rendered MP4 file does not exist or is 0 bytes.")

    proc = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            str(mp4_path),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    info = json.loads(proc.stdout)
    streams = info.get("streams", [])
    fmt = info.get("format", {})

    v_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
    a_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)
    errors: list[str] = []

    if not v_stream:
        errors.append("Missing video stream in MP4 container.")
        v_stream = {}

    v_codec = v_stream.get("codec_name", "")
    pix_fmt = v_stream.get("pix_fmt", "")
    width = int(v_stream.get("width", 0))
    height = int(v_stream.get("height", 0))
    r_frame_rate = v_stream.get("r_frame_rate", "30/1")
    try:
        num, den = r_frame_rate.split("/")
        fps = round(float(num) / float(den), 2)
    except Exception:
        fps = 30.0

    dur = float(fmt.get("duration") or v_stream.get("duration") or 0.0)

    if v_codec != "h264":
        errors.append(f"Expected video codec 'h264', got '{v_codec}'.")
    if pix_fmt != "yuv420p":
        errors.append(f"Expected pixel format 'yuv420p', got '{pix_fmt}'.")
    exp_w, exp_h = get_target_dimensions(expected_aspect_ratio)
    if (width, height) != (exp_w, exp_h):
        errors.append(f"Expected resolution {exp_w}x{exp_h}, got {width}x{height}.")
    if abs(fps - 30.0) > 0.5:
        errors.append(f"Expected frame rate 30 FPS, got {fps} FPS.")
    if abs(dur - expected_duration) > 0.6:
        errors.append(f"Expected duration {expected_duration:.1f}s, got {dur:.2f}s.")

    a_codec = a_stream.get("codec_name") if a_stream else None
    a_channels = int(a_stream.get("channels", 0)) if a_stream else None
    if expect_audio:
        if not a_stream:
            errors.append("Expected AAC audio stream, but no audio stream was found.")
        elif a_codec != "aac":
            errors.append(f"Expected audio codec 'aac', got '{a_codec}'.")

    raw_head = mp4_path.read_bytes()[:4096]
    moov_pos = raw_head.find(b"moov")
    mdat_pos = raw_head.find(b"mdat")
    faststart_ok = moov_pos != -1 and (mdat_pos == -1 or moov_pos < mdat_pos)
    if not faststart_ok:
        errors.append("MP4 faststart (moov atom before mdat) was not detected.")

    return FFprobeValidationResult(
        valid=len(errors) == 0,
        container_format=fmt.get("format_name", "mp4"),
        video_codec=v_codec,
        pixel_format=pix_fmt,
        width=width,
        height=height,
        aspect_ratio="9:16" if (width, height) == (1080, 1920) else ("16:9" if (width, height) == (1920, 1080) else f"{width}:{height}"),
        fps=fps,
        audio_codec=a_codec,
        audio_channels=a_channels,
        duration_seconds=round(dur, 2),
        expected_duration_seconds=round(expected_duration, 2),
        faststart_verified=faststart_ok,
        file_size_bytes=mp4_path.stat().st_size,
        errors=errors,
    )


def render_project_mp4_with_ffmpeg(
    req: FFmpegRenderRequest,
    output_dir: Path | None = None,
) -> tuple[Path, FFprobeValidationResult]:
    chk = is_ffmpeg_available()
    if not chk["available"]:
        raise FFmpegRenderError(
            "FFmpeg / FFprobe is not installed on the system PATH. Install FFmpeg to render final MP4 files."
        )
    if not req.scenes:
        raise FFmpegRenderError("Project must contain at least one scene to render.")

    target_w, target_h = get_target_dimensions(req.aspect_ratio)
    total_dur = round(sum(s.duration for s in req.scenes), 2)
    total_frames = max(1, int(round(total_dur * FPS)))

    scene_imgs = [_prepare_scene_image(s, target_w=target_w, target_h=target_h) for s in req.scenes]
    vignette = _create_vignette_mask(target_w=target_w, target_h=target_h)
    font = _load_caption_font(46)
    mark_font = _load_caption_font(30)
    rng = np.random.default_rng(seed=42)

    base_out = output_dir or (Path(__file__).resolve().parent / "storage" / "exports")
    base_out.mkdir(parents=True, exist_ok=True)
    safe_title = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in req.title).strip("_") or "video"
    out_mp4 = base_out / f"{safe_title}_{req.project_id}_{req.export_audio_mode}.mp4"

    with tempfile.TemporaryDirectory() as tmp:
        work_dir = Path(tmp)
        mixed_audio_wav = build_mixed_audio_wav_with_ffmpeg(req, total_dur, work_dir)
        expect_audio = mixed_audio_wav is not None

        ff_cmd = [
            "ffmpeg",
            "-y",
            "-f",
            "rawvideo",
            "-vcodec",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-s",
            f"{target_w}x{target_h}",
            "-r",
            str(FPS),
            "-i",
            "-",
        ]
        if mixed_audio_wav is not None:
            ff_cmd += ["-i", str(mixed_audio_wav)]

        ff_cmd += [
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-r",
            str(FPS),
            "-vf",
            "setsar=1",
        ]
        if mixed_audio_wav is not None:
            ff_cmd += [
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-ar",
                "44100",
                "-ac",
                "2",
                "-shortest",
            ]
        else:
            ff_cmd += ["-an"]

        ff_cmd += [
            "-t",
            f"{total_dur:.3f}",
            "-movflags",
            "+faststart",
            str(out_mp4),
        ]

        proc = subprocess.Popen(
            ff_cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        assert proc.stdin is not None
        stderr_chunks: list[bytes] = []
        stderr_reader = threading.Thread(
            target=lambda: stderr_chunks.append(proc.stderr.read()) if proc.stderr else None,
            daemon=True,
        )
        stderr_reader.start()
        try:
            for frame_idx in range(total_frames):
                t = frame_idx / float(FPS)
                frame_bytes = _render_frame_rgb(
                    t=t,
                    total_dur=total_dur,
                    scenes=req.scenes,
                    scene_imgs=scene_imgs,
                    vignette=vignette,
                    font=font,
                    rng=rng,
                    watermark=req.watermark,
                    mark_font=mark_font,
                    target_w=target_w,
                    target_h=target_h,
                )
                proc.stdin.write(frame_bytes)
            proc.stdin.close()
        except Exception as exc:
            proc.kill()
            raise FFmpegRenderError(f"Error streaming video frames to FFmpeg: {exc}") from exc

        ret = proc.wait(timeout=180)
        stderr_reader.join(timeout=5)
        stderr_bytes = b"".join(stderr_chunks)
        if ret != 0:
            err_txt = stderr_bytes.decode("utf-8", errors="replace")[-600:]
            raise FFmpegRenderError("FFmpeg rendering failed.", details=err_txt)

    validation = validate_video_with_ffprobe(
        mp4_path=out_mp4,
        expected_duration=total_dur,
        expect_audio=expect_audio,
        expected_aspect_ratio=req.aspect_ratio,
    )
    if not validation.valid:
        raise FFmpegRenderError(
            f"FFprobe validation failed: {'; '.join(validation.errors)}",
            details=json.dumps(dump_model(validation)),
        )
    return out_mp4, validation
