// ─────────────────────────────────────────────────────────────────────────────
// redis.js: the connections to Redis.
//
// Redis runs in Docker and stores two things for us:
//   1. the job_processing queue   (used by redis/job-queue.js)
//   2. the job records            (used by services/jobs.js)
//
// `redis`        the shared connection for normal reads and writes (API and workers).
// `workerRedis`  the connection a BullMQ Worker waits on for new jobs (workers only).
// ─────────────────────────────────────────────────────────────────────────────

import { Redis } from 'ioredis';
import { config } from '../config.js';

export const redis = new Redis(config.redisUrl, {
  // By default, if Redis is down, ioredis holds commands in memory until it reconnects,
  // which would leave an upload request hanging. With this off, commands fail straight away,
  // so the controller can reply 503 quickly.
  enableOfflineQueue: false,
});

// A BullMQ Worker sits on a "blocking" Redis command, waiting for the next job.
// That only works when ioredis never gives up on a command (maxRetriesPerRequest: null),
// and if Redis goes down the worker should simply wait and continue, not fail fast.
// So the worker gets its own connection with these settings.
// `lazyConnect` means it only connects when a worker actually uses it, so the API never opens it.
export const workerRedis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null,
  lazyConnect: true,
});

// ioredis keeps reconnecting in the background when Redis is down.
// Log one short line per failed attempt instead of a long stack trace.
redis.on('error', (err) => console.error(`[redis] ${err.code || err.message}`));
workerRedis.on('error', (err) => console.error(`[redis worker] ${err.code || err.message}`));
