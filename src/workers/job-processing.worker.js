// ─────────────────────────────────────────────────────────────────────────────
// workers/job-processing.worker.js: service worker 1.
//
// A separate Node process from the API (run it with `npm run worker`).
// It takes jobs off the job_processing queue one at a time and, for each job:
//   1. loads the job record
//   2. converts the uploaded file to a standardised 16 kHz mono WAV (ffmpeg)
//   3. updates the job record: status "standardised", file_path → the WAV
//   4. deletes the original upload, since the WAV replaces it
// (Chunking the WAV and filling the chunk_processing queue comes next.)
//
// Uses: services/jobs.js (job record), utils/ffmpeg.js (conversion),
//       redis/redis.js (connections), config.js (folders)
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs/promises';
import { Worker } from 'bullmq';
import { config } from '../config.js';
import { workerRedis } from '../redis/redis.js';
import { getJob, updateJob } from '../services/jobs.js';
import { standardiseAudio } from '../utils/ffmpeg.js';

// Create the output folder (storage/standardised) if it doesn't exist yet.
await fs.mkdir(config.standardisedDir, { recursive: true });

// ── processAudio ────────────────────────────────────────────────────────────
// BullMQ calls this once for every job it takes off the queue.
// `queueJob.data` is the object the API added: { job_id, file_path }.
// If this function throws, BullMQ retries the job (3 attempts, see redis/job-queue.js).
async function processAudio(queueJob) {
  const { job_id, file_path } = queueJob.data;

  // 1. Load the job record.
  const job = await getJob(job_id);
  if (!job) throw new Error(`job record ${job_id} not found`);

  // A retry after step 3 already succeeded: the WAV exists and the record points at it.
  if (job.status === 'standardised') return;

  // Note when the work first started, so /status shows the job has been picked up
  // (only on the first attempt; a retry keeps the original time).
  if (!job.started_at) await updateJob(job_id, { started_at: new Date().toISOString() });

  // 2. Convert to 16 kHz mono WAV: storage/standardised/<job_id>.wav
  const wav_path = `${config.standardisedDir}/${job_id}.wav`;
  await standardiseAudio(file_path, wav_path);

  // 3. The job record now points at the WAV instead of the upload.
  await updateJob(job_id, { status: 'standardised', file_path: wav_path });

  // 4. Delete the original upload to save space. This runs only after step 3,
  //    so the record never points at a file that no longer exists.
  await fs.rm(file_path, { force: true });

  console.log(`[worker 1] ${job_id} standardised → ${wav_path}`);
}

// ── Start the worker ────────────────────────────────────────────────────────
// It listens on the job_processing queue and runs processAudio for each job.
// concurrency 1 = one job at a time, because ffmpeg uses a lot of CPU.
const worker = new Worker('job_processing', processAudio, {
  connection: workerRedis,
  concurrency: 1,
});

console.log('[worker 1] waiting for jobs on job_processing');

// A job failed (processAudio threw). BullMQ retries it until the attempts run out;
// only after the last attempt do we mark the job record as failed.
worker.on('failed', async (queueJob, err) => {
  const attempts_left = queueJob.opts.attempts - queueJob.attemptsMade;
  console.error(`[worker 1] ${queueJob.data.job_id} failed (${attempts_left} attempts left): ${err.message}`);

  if (attempts_left <= 0) {
    await updateJob(queueJob.data.job_id, { status: 'failed', stage: 'standardise', error: err.message })
      .catch((e) => console.error(`[worker 1] could not mark job failed: ${e.message}`));
  }
});

// Ctrl+C (or a restart from `node --watch`): let the current job finish, then exit,
// so a job is never left half-done.
async function shutdown() {
  console.log('[worker 1] shutting down');
  await worker.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
