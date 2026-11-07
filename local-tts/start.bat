@echo off
setlocal
REM ============================================================================
REM Cinematic Studio — Start Local Offline Piper TTS Service (Windows)
REM Runs on http://127.0.0.1:5005. Keep this window open while using the app.
REM ============================================================================
cd /d "%~dp0"

if not exist .venv\Scripts\python.exe (
    echo [ERROR] Local virtual environment not found in %~dp0.venv
    echo Please run install.bat first to install Piper TTS and download voice models.
    pause
    exit /b 1
)

echo Starting Cinematic Studio Local Piper TTS Service on http://127.0.0.1:5005 ...
echo Keep this window open while generating voiceovers in the browser.
echo Press Ctrl+C to stop the service.
echo.
.venv\Scripts\python.exe server.py
pause
