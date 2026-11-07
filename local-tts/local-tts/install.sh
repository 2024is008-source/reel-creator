#!/usr/bin/env sh
# AI Cinematic Motivational Video Studio — One-Time Setup (macOS / Linux)
set -e
cd "$(dirname "$0")"

echo "============================================================================"
echo " AI Cinematic Video Studio — Local Backend Installer (macOS / Linux)"
echo "============================================================================"

python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt
python -m playwright install chromium
mkdir -p voices

echo "Downloading offline Piper TTS English voice models (Male & Female)..."
python -m piper.download_voices --download-dir voices \
  en_US-ryan-high \
  en_US-joe-medium \
  en_US-lessac-medium \
  en_US-amy-medium \
  en_GB-alan-medium \
  en_GB-alba-medium

echo ""
echo "Setup complete! Set GEMINI_API_KEY in ../.env and run ./start.sh"
