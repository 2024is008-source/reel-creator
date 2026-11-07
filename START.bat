@echo off
setlocal EnableExtensions
REM ============================================================================
REM  AI Cinematic Video Studio - ONE-CLICK START (Windows)
REM  First run: sets everything up (Python packages, voices, Flow browser).
REM  Every run: starts the local helper (voices + Google Flow + FFmpeg) on
REM  http://127.0.0.1:5005 and opens the studio in your browser.
REM ============================================================================
cd /d "%~dp0"
set "ROOT=%~dp0"
set "TTS=%ROOT%local-tts"
set "VENV=%TTS%\.venv"
set "PY_EXE=%VENV%\Scripts\python.exe"
set "PYTHONIOENCODING=utf-8"
set "PYTHONUTF8=1"
if not defined STUDIO_URL set "STUDIO_URL=https://id-preview--6e433c1f-4ab6-4f48-95b0-d5eb489f2c7e.lovable.app"

title AI Cinematic Video Studio
echo ============================================================================
echo   AI Cinematic Video Studio - starting up
echo ============================================================================
echo.

REM ---- 1. Python ------------------------------------------------------------
if exist "%PY_EXE%" goto :have_venv
set "SYS_PY="
where py >nul 2>nul && set "SYS_PY=py -3"
if not defined SYS_PY ( where python >nul 2>nul && set "SYS_PY=python" )
if not defined SYS_PY (
    echo [ERROR] Python 3.10 or newer was not found.
    echo         Install it from https://www.python.org/downloads/
    echo         and tick "Add python.exe to PATH" during setup, then run START.bat again.
    pause
    exit /b 1
)
echo [setup] Creating Python environment...
%SYS_PY% -m venv "%VENV%" || ( echo [ERROR] Could not create the Python environment. & pause & exit /b 1 )
:have_venv

REM ---- 2. Python packages (only when something is missing) -----------------
"%PY_EXE%" -c "import fastapi, uvicorn, pydantic, piper, playwright, PIL, numpy" >nul 2>nul
if errorlevel 1 (
    echo [setup] Installing Python packages - this takes a few minutes the first time...
    "%PY_EXE%" -m pip install --upgrade pip >nul
    "%PY_EXE%" -m pip install -r "%TTS%\requirements.txt" || ( echo [ERROR] Package install failed. Check your internet connection. & pause & exit /b 1 )
)

REM ---- 3. Playwright browser for Google Flow --------------------------------
if not exist "%TTS%\.playwright-ok" (
    echo [setup] Installing the Google Flow automation browser...
    "%PY_EXE%" -m playwright install chromium && ( echo ok> "%TTS%\.playwright-ok" )
)

REM ---- 4. Voices -------------------------------------------------------------
if not exist "%TTS%\voices" mkdir "%TTS%\voices"
set "NEED_VOICES="
for %%V in (en_US-ryan-high en_US-joe-medium en_US-lessac-medium en_US-amy-medium en_GB-alan-medium en_GB-alba-medium) do (
    if not exist "%TTS%\voices\%%V.onnx" set "NEED_VOICES=1"
)
if defined NEED_VOICES (
    echo [setup] Downloading offline voices - male and female, about 400 MB...
    "%PY_EXE%" -m piper.download_voices --download-dir "%TTS%\voices" en_US-ryan-high en_US-joe-medium en_US-lessac-medium en_US-amy-medium en_GB-alan-medium en_GB-alba-medium
)

REM ---- 4b. Caption font for FFmpeg export (same as the browser preview) ----
if not exist "%TTS%\fonts" mkdir "%TTS%\fonts"
if not exist "%TTS%\fonts\Kalam-Regular.ttf" (
    powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing 'https://github.com/google/fonts/raw/main/ofl/kalam/Kalam-Regular.ttf' -OutFile '%TTS%\fonts\Kalam-Regular.ttf' } catch {}" >nul 2>nul
)

REM ---- 5. FFmpeg (optional, for MP4 export) ---------------------------------
where ffmpeg >nul 2>nul || (
    echo [note] FFmpeg not found. MP4 export through FFmpeg needs it:
    echo        winget install Gyan.FFmpeg    then restart START.bat
    echo        The in-browser export still works without it.
)

REM ---- 6. Settings file ------------------------------------------------------
if not exist "%ROOT%.env" if exist "%ROOT%.env.example" (
    copy /y "%ROOT%.env.example" "%ROOT%.env" >nul
    echo [note] Created .env - add your GEMINI_API_KEY there if you want to use your own key.
)

REM ---- 7. Stop an old helper still holding port 5005 ------------------------
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:"127.0.0.1:5005 .*LISTENING"') do (
    echo [info] Stopping previous helper (PID %%P)...
    taskkill /PID %%P /F >nul 2>nul
)

REM ---- 8. Launch -------------------------------------------------------------
echo.
echo ============================================================================
echo   Local helper running at http://127.0.0.1:5005
echo   Studio: %STUDIO_URL%
echo   Keep this window open while you work. Close it (or Ctrl+C) to stop.
echo ============================================================================
echo.
start "" cmd /c "timeout /t 4 >nul & start "" "%STUDIO_URL%""
cd /d "%TTS%"
"%PY_EXE%" server.py
echo.
echo The local helper stopped.
pause
