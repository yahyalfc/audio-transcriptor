// ─────────────────────────────────────────────────────────────────────────────
// job-queue.js: the job_processing message queue.
//
// After a file is uploaded, the controller adds a job here: { job_id, file_path }.
// Service worker 1 (next part) will take jobs off this queue one by one and process
// them (standardise the audio, split it into chunks). Until that worker exists,
// jobs wait in the queue in the "waiting" state.
//
// The queue is run by the BullMQ library and stored in Redis
// under keys that start with "bull:job_processing:".
// ─────────────────────────────────────────────────────────────────────────────

import { Queue } from 'bullmq';
import { redis } from './redis.js';

export const jobQueue = new Queue('job_processing', {
  connection: redis,

  // Settings applied to every job added to this queue.
  // They only matter once a worker processes the jobs.
  defaultJobOptions: {
    attempts: 3, // if the worker fails on a job, BullMQ retries it, up to 3 tries in total...
    backoff: { type: 'exponential', delay: 5000 }, // ...waiting 5s before the 2nd try, 10s before the 3rd
    removeOnComplete: 1000, // keep only the last 1000 finished jobs so Redis doesn't fill up
    removeOnFail: 5000, // keep more failed jobs around for debugging
  },
});

// Log queue errors (e.g. Redis down) as one short line.
jobQueue.on('error', (err) => console.error(`[queue] ${err.code || err.message}`));
