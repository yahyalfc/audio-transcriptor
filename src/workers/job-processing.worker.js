// ─────────────────────────────────────────────────────────────────────────────
// workers/job-processing.worker.js: service worker 1.
//
// A separate Node process from the API (`npm run dev` starts both).
// It takes jobs off the job_processing queue one at a time and, for each job:
//
//   Standardise
//   1. loads the job record
//   2. converts the uploaded file to a standardised 16 kHz mono WAV (ffmpeg)
//   3. updates the job record: status "standardised", file_path → the WAV
//   4. deletes the original upload, since the WAV replaces it
//
//   Chunk
//   5. finds the pauses in the WAV (ffmpeg silencedetect = our VAD)
//   6. plans the chunks: ~30 s each, cut in a pause, never longer than 60 s
//   7. for each chunk: cuts it into its own WAV, creates its chunk record
//      (status "not_started") and adds it to the chunk_processing queue
//   8. updates the job record: status "chunked"
//
// Uses: services/jobs.js + services/chunks.js (records), utils/ffmpeg.js (audio),
//       utils/chunking.js (where to cut), redis/chunk-queue.js, config.js
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs/promises';
import { Worker } from 'bullmq';
import { config } from '../config.js';
import { workerRedis } from '../redis/redis.js';
import { chunkQueue } from '../redis/chunk-queue.js';
import { getJob, updateJob } from '../services/jobs.js';
import { createChunk } from '../services/chunks.js';
import { standardiseAudio, getDuration, detectSilences, cutChunk } from '../utils/ffmpeg.js';
import { planChunks } from '../utils/chunking.js';

// Create the output folder (storage/standardised) if it doesn't exist yet.
await fs.mkdir(config.standardisedDir, { recursive: true });

// ── processAudio ────────────────────────────────────────────────────────────
// BullMQ calls this once for every job it takes off the queue.
// `queueJob.data` is the object the API added: { job_id, file_path }.
// If this function throws, BullMQ retries the job (3 attempts, see redis/job-queue.js).
// On a retry, the steps that already finished are skipped (the job's status says which).
async function processAudio(queueJob) {
  const { job_id, file_path } = queueJob.data;
  const wav_path = `${config.standardisedDir}/${job_id}.wav`;

  // 1. Load the job record.
  const job = await getJob(job_id);
  if (!job) throw new Error(`job record ${job_id} not found`);

  // A retry after everything already succeeded: nothing left to do.
  if (job.status === 'chunked') return;

  // Note when the work first started, so /status shows the job has been picked up
  // (only on the first attempt; a retry keeps the original time).
  if (!job.started_at) await updateJob(job_id, { started_at: new Date().toISOString() });

  // ── Standardise (skipped on a retry if it already happened) ──
  if (job.status === 'queued') {
    // 2. Convert to 16 kHz mono WAV: storage/standardised/<job_id>.wav
    await standardiseAudio(file_path, wav_path);

    // 3. The job record now points at the WAV instead of the upload.
    await updateJob(job_id, { status: 'standardised', file_path: wav_path });

    // 4. Delete the original upload to save space. This runs only after step 3,
    //    so the record never points at a file that no longer exists.
    await fs.rm(file_path, { force: true });

    console.log(`[worker 1] ${job_id} standardised → ${wav_path}`);
  }

  // ── Chunk ──
  // 5. How long is the audio, and where are the pauses?
  const duration_sec = await getDuration(wav_path);
  const silences = await detectSilences(wav_path, {
    noise_db: config.silenceNoiseDb,
    min_sec: config.silenceMinSec,
  });

  // 6. Decide where to cut (pure arithmetic, see utils/chunking.js).
  const chunks = planChunks(duration_sec, silences, {
    target_sec: config.chunkTargetSec,
    max_sec: config.chunkMaxSec,
    min_sec: config.chunkMinSec,
  });

  // 7. Cut each chunk, record it, and queue it for service worker 2.
  const chunk_dir = `${config.chunksDir}/${job_id}`;
  await fs.mkdir(chunk_dir, { recursive: true });

  for (const chunk of chunks) {
    const number = String(chunk.index).padStart(3, '0'); // 0 → "000", so files sort in order
    // The id is built from the job_id and the chunk's position, so a retry produces the
    // same ids: BullMQ ignores a second add with the same id, and the record is overwritten.
    const chunk_job_id = `${job_id}-${number}`;
    const chunk_path = `${chunk_dir}/${number}.wav`;

    await cutChunk(wav_path, chunk_path, chunk.start_sec, chunk.end_sec);

    await createChunk({
      chunk_job_id,
      job_id,
      chunk_index: chunk.index,
      chunk_path,
      start_sec: chunk.start_sec,
      end_sec: chunk.end_sec,
    }); // status "not_started"

    // start_sec travels with the chunk, so worker 2 can turn the chunk's own timestamps
    // into timestamps of the whole file (chunk time + start_sec).
    await chunkQueue.add(
      'transcribe_chunk',
      { chunk_job_id, job_id, chunk_path, start_sec: chunk.start_sec, end_sec: chunk.end_sec },
      { jobId: chunk_job_id },
    );
  }

  // 8. All chunks are queued: the job is now "chunked".
  await updateJob(job_id, { status: 'chunked', chunk_count: chunks.length, duration_sec });

  console.log(`[worker 1] ${job_id} chunked → ${chunks.length} chunks in ${chunk_dir}`);
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
  const { job_id } = queueJob.data;
  const attempts_left = queueJob.opts.attempts - queueJob.attemptsMade;
  console.error(`[worker 1] ${job_id} failed (${attempts_left} attempts left): ${err.message}`);

  if (attempts_left <= 0) {
    try {
      // Which step broke? Still "queued" → converting failed; "standardised" → chunking failed.
      const job = await getJob(job_id);
      const stage = job?.status === 'standardised' ? 'chunk' : 'standardise';
      await updateJob(job_id, { status: 'failed', stage, error: err.message });
    } catch (e) {
      console.error(`[worker 1] could not mark job failed: ${e.message}`);
    }
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
