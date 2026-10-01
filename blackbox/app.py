# ─────────────────────────────────────────────────────────────────────────────
# blackbox/app.py: the Transcribing Blackbox.
#
# A small HTTP service (FastAPI) that turns one audio chunk into a transcript.
# It knows nothing about jobs, chunks or Redis: audio in, JSON out.
#
#   GET  /health       → { ok, model }
#   POST /transcribe   multipart field "file" (a WAV chunk)
#                      → { language, duration_sec, aligned,
#                          segments: [{ start, end, text, words: [{ word, start, end }] }] }
#
# How a chunk is transcribed:
#   1. faster-whisper (run through WhisperX) writes the text in segments, with rough times
#   2. WhisperX aligns the text to the audio (wav2vec2) to get accurate word-level times
# All times are in seconds from the start of the chunk.
#
# Settings (env vars, see docker-compose.yml): WHISPER_MODEL (small), COMPUTE_TYPE (int8),
# DEVICE (cpu), BATCH_SIZE (8).
# Called by: src/utils/blackbox.js (service worker 2)
# ─────────────────────────────────────────────────────────────────────────────

import os
import tempfile

import whisperx
from fastapi import FastAPI, File, HTTPException, UploadFile

WHISPER_MODEL = os.getenv("WHISPER_MODEL", "small")
COMPUTE_TYPE = os.getenv("COMPUTE_TYPE", "int8")
DEVICE = os.getenv("DEVICE", "cpu")
BATCH_SIZE = int(os.getenv("BATCH_SIZE", "8"))

# Load the Whisper model once, when the service starts (it takes a few seconds and
# about 1 GB of memory), and reuse it for every request.
print(f"[blackbox] loading whisper model '{WHISPER_MODEL}' on {DEVICE} ({COMPUTE_TYPE})", flush=True)
model = whisperx.load_model(WHISPER_MODEL, DEVICE, compute_type=COMPUTE_TYPE)
print("[blackbox] ready", flush=True)

# Alignment models, one per language, loaded the first time that language comes up.
# None = WhisperX has no alignment model for that language.
align_models = {}


def get_align_model(language):
    if language not in align_models:
        try:
            align_models[language] = whisperx.load_align_model(language_code=language, device=DEVICE)
        except ValueError:
            print(f"[blackbox] no alignment model for '{language}', keeping segment times", flush=True)
            align_models[language] = None
    return align_models[language]


app = FastAPI(title="Transcribing Blackbox")


@app.get("/health")
def health():
    return {"ok": True, "model": WHISPER_MODEL}


# A plain `def` (not async): FastAPI runs it in a thread, so the slow transcription
# doesn't block the server from answering /health in the meantime.
@app.post("/transcribe")
def transcribe(file: UploadFile = File(...)):
    # 1. Save the upload to a temp file, because WhisperX reads audio from a path (via ffmpeg).
    with tempfile.NamedTemporaryFile(suffix=os.path.splitext(file.filename or "")[1] or ".wav") as tmp:
        tmp.write(file.file.read())
        tmp.flush()
        try:
            audio = whisperx.load_audio(tmp.name)  # 16 kHz mono float samples
        except Exception as err:
            raise HTTPException(status_code=400, detail=f"could not read audio: {err}")

    duration_sec = round(len(audio) / 16000, 3)

    # 2. Transcribe with faster-whisper. The language is detected for every chunk.
    result = model.transcribe(audio, batch_size=BATCH_SIZE)
    language = result["language"]
    segments = result["segments"]

    # 3. Word-level timestamps with WhisperX alignment, when the language supports it.
    aligned = False
    align = get_align_model(language)
    if align and segments:
        align_model, metadata = align
        segments = whisperx.align(segments, align_model, metadata, audio, DEVICE)["segments"]
        aligned = True

    # 4. Reply with plain JSON, times rounded to ms. Some words (e.g. numbers) can't be
    #    aligned and have no times; they're kept with start/end = null.
    def r(t):
        return None if t is None else round(float(t), 3)

    return {
        "language": language,
        "duration_sec": duration_sec,
        "aligned": aligned,
        "segments": [
            {
                "start": r(s.get("start")),
                "end": r(s.get("end")),
                "text": s["text"].strip(),
                "words": [
                    {"word": w["word"], "start": r(w.get("start")), "end": r(w.get("end"))}
                    for w in s.get("words", [])
                ],
            }
            for s in segments
        ],
    }
