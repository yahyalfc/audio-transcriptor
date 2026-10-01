// ─────────────────────────────────────────────────────────────────────────────
// redis.js: the single shared connection to Redis.
//
// Redis runs in Docker and stores two things for us:
//   1. the job_processing queue   (used by redis/job-queue.js)
//   2. the job records            (used by services/jobs.js)
// Both reuse this one connection instead of opening their own.
// ─────────────────────────────────────────────────────────────────────────────

import { Redis } from 'ioredis';
import { config } from '../config.js';

export const redis = new Redis(config.redisUrl, {
  // By default, if Redis is down, ioredis holds commands in memory until it reconnects,
  // which would leave an upload request hanging. With this off, commands fail straight away,
  // so the controller can reply 503 quickly.
  enableOfflineQueue: false,
});

// ioredis keeps reconnecting in the background when Redis is down.
// Log one short line per failed attempt instead of a long stack trace.
redis.on('error', (err) => console.error(`[redis] ${err.code || err.message}`));
