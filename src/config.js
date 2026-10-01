// ─────────────────────────────────────────────────────────────────────────────
// config.js: all app settings in one place.
//
// Each setting has a default and can be overridden with an environment variable,
// e.g. `PORT=4000 MAX_UPLOAD_MB=100 npm run dev`.
// Imported by: server.js, utils/upload.js, redis/redis.js
// ─────────────────────────────────────────────────────────────────────────────

export const config = {
  // Port the Express server listens on.
  port: process.env.PORT || 3000,

  // Folder where uploaded audio files are saved.
  // Relative to the folder you start the app from (the project root when using npm scripts).
  uploadDir: process.env.UPLOAD_DIR || 'storage/uploads',

  // Largest upload we accept, in megabytes. Bigger files are rejected with 413.
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB) || 500,

  // Address of Redis, which runs in Docker (`docker compose up -d`).
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
};
