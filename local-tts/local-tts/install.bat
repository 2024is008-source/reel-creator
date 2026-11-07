@echo off
setlocal
REM ============================================================================
REM AI Cinematic Motivational Video Studio — One-Time Windows Setup
REM Installs Python virtual environment, FastAPI, Google Gemini SDK,
REM Playwright Chromium (for Google Flow / Nano Banana), Piper TTS + 6 voices,
REM and checks FFmpeg / FFprobe availability.
REM ============================================================================
cd /d "%~dp0"

echo ============================================================================
echo  AI Cinematic Video Studio - Local Backend Installer (Windows)
echo ============================================================================
echo.

where py >nul 2>nul && (set PY=py -3) || (set PY=python)
%PY% --version >nul 2>nul || (
    echo [ERROR] Python 3.10+ was not found on your PATH.
    echo Please install Python 3.10 or newer from https://www.python.org/downloads/
    echo Make sure to check "Add python.exe to PATH" during installation.
    pause
    exit /b 1
)

echo [1/5] Creating local Python virtual environment (.venv)...
if not exist .venv (
    %PY% -m venv .venv || (
        echo [ERROR] Failed to create virtual environment.
        pause
        exit /b 1
    )
)

call .venv\Scripts\activate.bat

echo [2/5] Upgrading pip and installing Python dependencies (FastAPI, Gemini, Playwright, Piper, Pillow, NumPy)...
python -m pip install --upgrade pip
pip install -r requirements.txt || (
    echo [ERROR] Failed to install dependencies from requirements.txt.
    pause
    exit /b 1
)

echo [3/5] Installing Playwright Chromium browser for Google Flow / Nano Banana automation...
python -m playwright install chromium

if not exist voices mkdir voices

echo [4/5] Downloading offline Piper TTS English voice models (Male ^& Female)...
echo       - en_US-ryan-high     (Male, American English - Deep Cinematic)
echo       - en_US-joe-medium    (Male, American English - Warm Grounded)
echo       - en_US-lessac-medium (Female, American English - Expressive Natural)
echo       - en_US-amy-medium    (Female, American English - Calm Soothing)
echo       - en_GB-alan-medium   (Male, British English - Classic Narrator)
echo       - en_GB-alba-medium   (Female, British English - Soft Articulate)
echo.
python -m piper.download_voices --download-dir voices en_US-ryan-high en_US-joe-medium en_US-lessac-medium en_US-amy-medium en_GB-alan-medium en_GB-alba-medium

echo.
echo [5/5] Checking FFmpeg and FFprobe on system PATH...
where ffmpeg >nul 2>nul && (echo       [OK] FFmpeg detected) || (echo       [NOTE] FFmpeg not on PATH. Install via: winget install Gyan.FFmpeg)
where ffprobe >nul 2>nul && (echo       [OK] FFprobe detected) || (echo       [NOTE] FFprobe not on PATH. Install via: winget install Gyan.FFmpeg)

echo.
echo ============================================================================
echo  Setup Complete!
echo  1. Set GEMINI_API_KEY in .env (copy from .env.example) or in Studio Settings.
echo  2. Double-click start.bat to launch the local service at http://127.0.0.1:5005
echo ============================================================================
pause
