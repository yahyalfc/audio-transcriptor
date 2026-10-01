// ─────────────────────────────────────────────────────────────────────────────
// utils/ffmpeg.js: runs ffmpeg / ffprobe on audio files.
//
// ffmpeg and ffprobe are command-line programs (install with `brew install ffmpeg`).
// We start them with Node's child_process.spawn, just as if we typed the command
// in a terminal, and wait for them to finish.
// (fluent-ffmpeg is not used: it is no longer maintained, and with spawn the
//  exact command is right here to read.)
//
//   standardiseAudio  any audio → 16 kHz mono WAV
//   getDuration       length of a file in seconds
//   detectSilences    where the quiet gaps (pauses) are
//   cutChunk          copy one time range of a WAV into its own file
//
// Used by: workers/job-processing.worker.js (service worker 1)
// ─────────────────────────────────────────────────────────────────────────────

import { spawn } from 'node:child_process';

// Convert any audio file (mp3, m4a, wav, ...) into the standard format the
// Transcribing Blackbox expects: 16 kHz, mono, 16-bit WAV.
//   await standardiseAudio('storage/uploads/abc.mp3', 'storage/standardised/<job_id>.wav');
export async function standardiseAudio(input_path, output_path) {
  await run('ffmpeg', [
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

// The length of an audio file in seconds, e.g. 373.97. ffprobe prints just the number.
export async function getDuration(path) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration', // only the duration...
    '-of', 'default=noprint_wrappers=1:nokey=1', // ...printed as a bare number
    path,
  ]);
  return Number(stdout.trim());
}

// Find the pauses: every stretch quieter than `noise_db` that lasts at least `min_sec`.
// This is our Voice Activity Detection (VAD): ffmpeg's silencedetect filter measures
// loudness, and a quiet gap in speech is a natural place to cut.
// Returns [{ start, end }] in seconds, e.g. [{ start: 14.6, end: 15.25 }, ...].
export async function detectSilences(path, { noise_db, min_sec }) {
  // `-f null -` = decode the audio but don't write any output; we only want the report.
  const { stderr } = await run('ffmpeg', [
    '-hide_banner', '-nostats',
    '-i', path,
    '-af', `silencedetect=noise=${noise_db}dB:d=${min_sec}`,
    '-f', 'null', '-',
  ]);

  // silencedetect reports on stderr, in lines like:
  //   [silencedetect @ 0x..] silence_start: 14.596
  //   [silencedetect @ 0x..] silence_end: 15.251 | silence_duration: 0.654
  const silences = [];
  for (const line of stderr.split('\n')) {
    const start = line.match(/silence_start: ([\d.]+)/);
    const end = line.match(/silence_end: ([\d.]+)/);
    if (start) silences.push({ start: Number(start[1]), end: null });
    if (end && silences.length) silences[silences.length - 1].end = Number(end[1]);
  }
  // A silence that runs to the very end of the file has no silence_end; drop it.
  return silences.filter((s) => s.end !== null);
}

// Copy the part of a WAV between start_sec and end_sec into its own WAV file.
// The samples are re-written rather than stream-copied, so the cut lands on the
// exact sample, and the chunk's timestamps line up exactly with start_sec.
export async function cutChunk(input_path, output_path, start_sec, end_sec) {
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-y',
    '-ss', String(start_sec), // start here...
    '-to', String(end_sec),   // ...and stop here
    '-i', input_path,
    '-c:a', 'pcm_s16le',
    output_path,
  ]);
}

// Run a program (ffmpeg or ffprobe) with `args` and wait for it to finish.
// Resolves with everything it printed ({ stdout, stderr }) when it exits with code 0;
// otherwise rejects with the program's own error text.
function run(program, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args);

    // Collect what the program prints.
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));

    // The program couldn't start at all (most likely ffmpeg isn't installed).
    child.on('error', (err) => {
      reject(err.code === 'ENOENT' ? new Error(`${program} not installed (brew install ffmpeg)`) : err);
    });

    // The program finished: exit code 0 means success.
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`${program} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}
