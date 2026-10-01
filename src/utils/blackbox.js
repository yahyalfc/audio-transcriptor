// ─────────────────────────────────────────────────────────────────────────────
// utils/blackbox.js: talks to the Transcribing Blackbox.
//
// The Blackbox is a separate Python service (blackbox/, runs in Docker) that
// transcribes audio with faster-whisper and WhisperX. Service worker 2 calls
// transcribe() and gets JSON back; all the HTTP details stay in this file.
//
//   POST {BLACKBOX_URL}/transcribe   (multipart, field "file" = the chunk WAV)
//   → { language, duration_sec, aligned, segments: [{ start, end, text, words }] }
//
// The times in the reply are relative to the chunk (they start at 0).
// Used by: workers/chunk-processing.worker.js
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

// Send one chunk to the Blackbox and return its transcript.
// Throws a readable error when the Blackbox is down, too slow, or replies with an error.
export async function transcribe(chunk_path) {
  // 1. Read the WAV and put it in a multipart form, like `curl -F file=@chunk.wav`.
  const audio = await fs.readFile(chunk_path);
  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/wav' }), path.basename(chunk_path));

  // 2. POST it. AbortSignal.timeout stops waiting after BLACKBOX_TIMEOUT_MS.
  let res;
  try {
    res = await fetch(`${config.blackboxUrl}/transcribe`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(config.blackboxTimeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') {
      throw new Error(`Transcribing Blackbox took longer than ${config.blackboxTimeoutMs} ms`);
    }
    throw new Error(`Transcribing Blackbox unreachable at ${config.blackboxUrl} (${err.cause?.code || err.message})`);
  }

  // 3. Anything other than 200 is an error; include the Blackbox's own message.
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Transcribing Blackbox replied ${res.status}: ${body.slice(0, 300)}`);
  }

  return res.json();
}
