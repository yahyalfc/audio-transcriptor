# ─────────────────────────────────────────────────────────────────────────────
# Transcribing Blackbox image: Python + ffmpeg + faster-whisper/WhisperX + FastAPI.
# Built and started by docker-compose.yml (`docker compose up -d --build blackbox`).
# ─────────────────────────────────────────────────────────────────────────────
FROM python:3.11-slim

# ffmpeg: WhisperX uses it to read the audio files.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install the Python libraries first, so this slow layer is cached when only app.py changes.
# The extra index gives the CPU-only build of torch (much smaller, no CUDA).
COPY requirements.txt .
RUN pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu -r requirements.txt

COPY app.py .

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
