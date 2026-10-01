// ─────────────────────────────────────────────────────────────────────────────
// config.js: all app settings in one place.
//
// Each setting has a default and can be overridden with an environment variable,
// e.g. `PORT=4000 MAX_UPLOAD_MB=100 npm run dev`.
// Imported by: server.js, utils/upload.js, redis/redis.js, workers/job-processing.worker.js
// ─────────────────────────────────────────────────────────────────────────────

export const config = {
  // Port the Express server listens on.
  port: process.env.PORT || 3000,

  // Folder where uploaded audio files are saved.
  // Relative to the folder you start the app from (the project root when using npm scripts).
  uploadDir: process.env.UPLOAD_DIR || 'storage/uploads',

  // Folder where service worker 1 saves the standardised (16 kHz mono WAV) files.
  standardisedDir: process.env.STANDARDISED_DIR || 'storage/standardised',

  // Folder where service worker 1 saves the chunks: storage/chunks/<job_id>/000.wav, 001.wav, ...
  chunksDir: process.env.CHUNKS_DIR || 'storage/chunks',

  // How the standardised audio is cut into chunks (see utils/chunking.js).
  chunkTargetSec: Number(process.env.CHUNK_TARGET_SEC) || 30, // aim for chunks of about 30 s,
  chunkMaxSec: Number(process.env.CHUNK_MAX_SEC) || 60, //        never longer than 60 s,
  chunkMinSec: Number(process.env.CHUNK_MIN_SEC) || 10, //        and (except the last) not shorter than 10 s.

  // What counts as a pause (see detectSilences in utils/ffmpeg.js):
  // quieter than -30 dB for at least 0.5 s.
  silenceNoiseDb: Number(process.env.SILENCE_NOISE_DB) || -30,
  silenceMinSec: Number(process.env.SILENCE_MIN_SEC) || 0.5,

  // Largest upload we accept, in megabytes. Bigger files are rejected with 413.
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB) || 500,

  // Address of Redis, which runs in Docker (`docker compose up -d`).
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
};
