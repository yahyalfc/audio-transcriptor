// ─────────────────────────────────────────────────────────────────────────────
// utils/ffmpeg.js: runs ffmpeg to convert audio files.
//
// ffmpeg is a command-line program (install it with `brew install ffmpeg`).
// We start it with Node's child_process.spawn, just as if we typed the command
// in a terminal, and wait for it to finish.
// (fluent-ffmpeg is not used: it is no longer maintained, and with spawn the
//  exact ffmpeg command is right here to read.)
//
// Used by: workers/job-processing.worker.js (service worker 1)
// ─────────────────────────────────────────────────────────────────────────────

import { spawn } from 'node:child_process';

// Convert any audio file (mp3, m4a, wav, ...) into the standard format the
// Transcribing Blackbox expects: 16 kHz, mono, 16-bit WAV.
//   await standardiseAudio('storage/uploads/abc.mp3', 'storage/standardised/<job_id>.wav');
export function standardiseAudio(input_path, output_path) {
  return runFfmpeg([
    '-hide_banner', '-loglevel', 'error', // only print real errors
    '-y',                                  // overwrite the output if it exists (e.g. on a retry)
    '-i', input_path,                      // the input file
    '-vn',                                 // drop any video / cover-art stream
    '-ac', '1',                            // 1 audio channel  = mono
    '-ar', '16000',                        // 16000 samples/s  = 16 kHz
    '-c:a', 'pcm_s16le',                   // plain 16-bit WAV samples
    output_path,
  ]);
}

// Run `ffmpeg <args>` and wait for it to finish.
// Resolves when ffmpeg exits with code 0; otherwise rejects with ffmpeg's own error text.
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', args);

    // Collect what ffmpeg prints on stderr, to use as the error message if it fails.
    let stderr = '';
    ffmpeg.stderr.on('data', (chunk) => (stderr += chunk));

    // The program couldn't start at all (most likely ffmpeg isn't installed).
    ffmpeg.on('error', (err) => {
      reject(err.code === 'ENOENT' ? new Error('ffmpeg not installed (brew install ffmpeg)') : err);
    });

    // The program finished: exit code 0 means success.
    ffmpeg.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`));
    });
  });
}
