#!/usr/bin/env sh
# Starts the Cinematic Studio local Piper TTS service at http://127.0.0.1:5005
cd "$(dirname "$0")"
if [ -x ".venv/bin/python" ]; then
  exec .venv/bin/python server.py
else
  exec python3 server.py
fi
