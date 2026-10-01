// ─────────────────────────────────────────────────────────────────────────────
// chunk-queue.js: the chunk_processing message queue.
//
// After service worker 1 has cut a job's audio into chunks, it adds one entry
// here per chunk: { chunk_job_id, job_id, chunk_path, start_sec, end_sec }.
// Service worker 2 (workers/chunk-processing.worker.js) takes them off one by one,
// in order, and sends each chunk to the Transcribing Blackbox.
//
// Stored in Redis under keys that start with "bull:chunk_processing:".
// ─────────────────────────────────────────────────────────────────────────────

import { Queue } from 'bullmq';
import { redis } from './redis.js';

export const chunkQueue = new Queue('chunk_processing', {
  connection: redis,

  // Same retry settings as the job_processing queue (see job-queue.js).
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});

// Log queue errors (e.g. Redis down) as one short line.
chunkQueue.on('error', (err) => console.error(`[chunk queue] ${err.code || err.message}`));
