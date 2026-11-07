# AI Cinematic Motivational Video Studio

Full-stack AI motivational video creation platform combining **Google Gemini API** (script, story, captions, narration, and Visual Bible), **Google Flow / Nano Banana via Playwright** (painted 2D anime 9:16 scene generation with persistent browser profile), **Local Offline Piper TTS** (male & female English WAV narration), **User-Uploaded Background Music Library** (IndexedDB MP3/WAV/M4A), and **FFmpeg + FFprobe** (`1080 × 1920`, `9:16`, `30 FPS`, `H.264` `libx264`, `AAC`, `yuv420p`, `+faststart` MP4 export with automatic ducking).

## 1. Required AI & Media Architecture

| Feature | Technology | Module / Adapter |
| :--- | :--- | :--- |
| Script, Story, Captions, Visual Bible & Prompts | Google Gemini API (`GEMINI_API_KEY`) | `services/gemini/gemini_service.py` & `src/lib/studio.functions.ts` |
| Scene Image Generation | Google Flow / Nano Banana (`FlowProjectNavigator` + TRPC UUID Media Download) | `services/flow/flow_automation.py` & `services/flow/prompts.py` |
| Browser Automation & Queue | Direct-CDP Anti-Detection Chrome (`:9222`) + Playwright Persistent Fallback | `services/flow/browser_manager.py` & `services/flow/flow_job_manager.py` |
| Image Verification & Versioning | Pillow (`1080×1920` 9:16 normalization) | `services/flow/image_download.py` |
| Local Voiceover | Piper TTS (100% Offline WAV) | `local-tts/server.py` & `src/lib/local-tts.ts` |
| Background Music Library | User-Uploaded MP3 / WAV / M4A | `src/lib/projects.ts` (IndexedDB `music-track:*`) |
| Audio Mixing & Ducking | FFmpeg (`alimiter`, `afade`, 8–12% speech ducking) | `services/ffmpeg_renderer.py` & `src/lib/render.ts` |
| Video Rendering & Validation | FFmpeg (`libx264`, `aac`, `yuv420p`, `+faststart`) + FFprobe | `services/ffmpeg_renderer.py` |

## 2. Complete 7-Step Video Generation Workflow

1. **Step 1 — User Message (`/create`)**: Enter video title, category, topic, main message, story idea, audience, language, and duration (`21s` default).
2. **Step 2 — Gemini Script & Visual Bible**: Gemini generates validated structured JSON with `title`, `theme`, `duration_seconds` (`21s`), `visual_style` (`cinematic painted 2D anime`), `narration`, `visual_bible` (`character_appearance`, `clothing`, `hair`, `age_range`, `body_proportions`, `environment`, `color_palette`, `lighting`, `art_style`), and `5–6` scenes (`~3.5s` each) with connected captions and character-consistent `image_prompt`s.
3. **Step 3 — Scene Image Generation (Playwright + Google Flow / Nano Banana)**: Click **Connect Flow Browser** to launch the persistent Playwright Chromium profile (`services/.browser_profile`), complete Google Sign-In manually if prompted, and queue scenes for Nano Banana 9:16 painted 2D anime generation. Every scene supports individual prompt editing, single-scene regeneration, version history (`v1`, `v2`, ...), and manual image upload fallback.
4. **Step 4 — Local Piper Voiceover**: Select an installed American or British English male/female Piper voice model, adjust speed (`0.5×–1.5×`), preview the voice, and synthesize offline `.wav` narration.
5. **Step 5 — User-Uploaded Background Music**: Upload `.mp3`, `.wav`, or `.m4a` tracks into the IndexedDB Background Music Library, preview tracks, and select a track for your project.
6. **Step 6 — Audio Mixing & Video Preview**: Default levels set Voiceover to `100%` and Background Music to `18%` with smooth fade-in (`1.5s`), fade-out (`2.0s`), and automatic music ducking (`8–12%` during speech, gradual return on pause). Preview the synchronized `1080 × 1920` canvas with Play, Pause, Restart, Seek scrubber, Mute, and Volume controls.
7. **Step 7 — Final Export (FFmpeg + FFprobe)**: Export a `1080 × 1920` (`9:16`), `30 FPS`, `H.264` (`libx264`), `AAC`, `yuv420p`, `+faststart` MP4 validated automatically by `ffprobe`.

## 3. Windows Installation & Startup Instructions

### Prerequisites (Windows 10 / 11)

- **Python 3.10+**: Download from [python.org/downloads](https://www.python.org/downloads/) and check **"Add python.exe to PATH"**.
- **FFmpeg & FFprobe**: Install via Winget (`winget install Gyan.FFmpeg`) or Chocolatey (`choco install ffmpeg`) so `ffmpeg` and `ffprobe` are on your system `PATH`.
- **Node.js 20+ or Bun**: For running the frontend web application.

### Step 1: Configure `.env`

Copy `.env.example` to `.env` in the project root and set your server-side Gemini API key:

```ini
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-3.5-flash
GOOGLE_FLOW_URL=https://labs.google/fx/tools/flow
FLOW_BROWSER_PROFILE_DIR=./services/.browser_profile
FLOW_HEADLESS=false
LOCAL_TTS_PORT=5005
PIPER_VOICES_DIR=./local-tts/voices
```

*(You can also set `GEMINI_API_KEY` at runtime from the **Settings** drawer on the Dashboard or inside the Project Studio.)*

### Step 2: Run One-Time Local Backend Setup (`local-tts\install.bat`)

Open Command Prompt or PowerShell in the project folder and run:

```bat
cd local-tts
install.bat
```

This script:
1. Creates `local-tts\.venv` and installs `fastapi`, `uvicorn`, `pydantic`, `pillow`, `numpy`, `playwright`, `google-genai`, and `piper-tts`.
2. Runs `python -m playwright install chromium` for Google Flow / Nano Banana browser automation.
3. Downloads 6 English male and female Piper TTS `.onnx` voice models into `local-tts\voices\`.
4. Checks `ffmpeg` and `ffprobe` on your `PATH`.

### Step 3: Start the Local Backend Service (`local-tts\start.bat`)

```bat
cd local-tts
start.bat
```

This starts the unified local service at `http://127.0.0.1:5005`. Keep this window open while using the studio.

### Step 4: Start the Web Application

In a second terminal at the project root:

```sh
npm install
npm run dev
```

## 4. Testing Instructions

Run the automated end-to-end verification suite (tests Gemini JSON validation & error handling, Visual Bible consistency across 6 scenes, Playwright Flow job queue & sign-in pause/crash recovery, Local Piper TTS synthesis, MP3/WAV upload & ducking, real 21-second `1080×1920` `30 FPS` `H.264`/`AAC` `yuv420p` `+faststart` MP4 rendering via FFmpeg, and `ffprobe` stream validation):

```sh
python3 services/test_e2e_pipeline.py
```
