// ─────────────────────────────────────────────────────────────────────────────
// workers/chunk-processing.worker.js: service worker 2.
//
// A separate Node process (`npm run dev` starts it with the API and worker 1).
// It takes chunks off the chunk_processing queue one at a time, in the order
// worker 1 added them (000, 001, 002, ...), and for each chunk:
//
//   1. loads the chunk record
//   2. sets the chunk status to "processing" and stores its length (duration_sec);
//      the job's status becomes "transcribing" once its first chunk starts
//   3. sends the chunk WAV to the Transcribing Blackbox (faster-whisper + WhisperX)
//   4. shifts the returned timestamps by the chunk's start_sec (time offset adjustment),
//      so they match the whole file instead of starting at 0 for every chunk
//   5. saves the adjusted JSON to storage/transcripts/<job_id>/<NNN>.json
//   6. sets the chunk status to "completed"
//   7. if all of the job's chunks are now completed: merges their transcripts into one,
//      saves it in the job record's "transcription" field and sets the job to "completed"
//
// Uses: services/jobs.js + services/chunks.js (records), utils/blackbox.js (the HTTP call),
//       utils/transcript.js (offset + merge), config.js
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs/promises';
import { Worker } from 'bullmq';
import { config } from '../config.js';
import { workerRedis } from '../redis/redis.js';
import { getJob, updateJob } from '../services/jobs.js';
import { getChunk, updateChunk } from '../services/chunks.js';
import { transcribe } from '../utils/blackbox.js';
import { offsetTimestamps, mergeTranscripts } from '../utils/transcript.js';

// ── transcribeChunk ─────────────────────────────────────────────────────────
// BullMQ calls this once for every chunk it takes off the queue.
// `queueJob.data` is what worker 1 added: { chunk_job_id, job_id, chunk_path, start_sec, end_sec }.
// If this function throws, BullMQ retries the chunk (3 attempts, see redis/chunk-queue.js).
async function transcribeChunk(queueJob) {
  const { chunk_job_id, job_id, chunk_path, start_sec, end_sec } = queueJob.data;

  // 1. Load the chunk record.
  const chunk = await getChunk(chunk_job_id);
  if (!chunk) throw new Error(`chunk record ${chunk_job_id} not found`);

  // A retry after the chunk already succeeded: only the merge check may be left
  // (e.g. the worker stopped between step 6 and step 7).
  if (chunk.status === 'completed') return finishJobIfDone(job_id);

  // 2. Mark it as being worked on, and store its length (rounded to ms).
  const duration_sec = Math.round((end_sec - start_sec) * 1000) / 1000;
  await updateChunk(chunk_job_id, {
    status: 'processing',
    duration_sec,
    started_at: new Date().toISOString(),
  });
  console.log(`[worker 2] ${chunk_job_id} processing (${duration_sec} s)`);

  //    The job is now being transcribed. Only "chunked" moves to "transcribing", so a job
  //    that's already transcribing, completed or failed is left alone. (If worker 1 writes
  //    "chunked" a moment after this, the next chunk sets "transcribing" again.)
  const job = await getJob(job_id);
  if (job?.status === 'chunked') await updateJob(job_id, { status: 'transcribing' });

  // 3. Transcribe it. This waits until the Blackbox replies (seconds to minutes on CPU).
  //    The times in the reply start at 0, because the Blackbox only sees this chunk.
  const result = await transcribe(chunk_path);

  // 4. Time offset adjustment: add the chunk's start in the whole file to every
  //    segment and word time (chunk 000 starts at 0, so its times don't change).
  const transcript = offsetTimestamps(result, start_sec);

  // 5. Save the transcript next to the others of the same job:
  //    storage/transcripts/<job_id>/002.json (the same number as the chunk WAV).
  const number = String(chunk.chunk_index).padStart(3, '0');
  const transcript_dir = `${config.transcriptsDir}/${job_id}`;
  const transcript_path = `${transcript_dir}/${number}.json`;
  await fs.mkdir(transcript_dir, { recursive: true });
  await fs.writeFile(transcript_path, JSON.stringify(transcript, null, 2));

  // 6. Done: the record points at the transcript.
  await updateChunk(chunk_job_id, { status: 'completed', transcript_path, language: transcript.language });

  console.log(`[worker 2] ${chunk_job_id} completed → ${transcript_path} (${transcript.segments.length} segments, +${start_sec} s)`);

  // 7. Was this the job's last unfinished chunk? Then merge.
  await finishJobIfDone(job_id);
}

// ── finishJobIfDone ─────────────────────────────────────────────────────────
// Called after every completed chunk. If all of the job's chunks are completed
// (and the job isn't completed yet), combine their transcripts into one and
// complete the job. Otherwise do nothing: other chunks are still to come.
// Checking "all completed" rather than "is this the last chunk" means it also works
// when a retried chunk finishes after a later one.
async function finishJobIfDone(job_id) {
  // a. Already completed (or unknown): nothing to do.
  const job = await getJob(job_id);
  if (!job || job.status === 'completed') return;

  // b. Are all chunks completed? Chunk ids are <job_id>-000 up to chunk_count - 1.
  const chunk_count = Number(job.chunk_count);
  const ids = Array.from({ length: chunk_count }, (_, i) => `${job_id}-${String(i).padStart(3, '0')}`);
  const chunks = await Promise.all(ids.map(getChunk));
  if (!chunk_count || !chunks.every((chunk) => chunk?.status === 'completed')) return;

  // c. Read every chunk's transcript (in chunk order) and merge them into one.
  const transcripts = await Promise.all(
    chunks.map(async (chunk) => JSON.parse(await fs.readFile(chunk.transcript_path, 'utf8'))),
  );
  const transcription = mergeTranscripts(transcripts, Number(job.duration_sec));

  // d. Save it on the job record (Redis stores text, so as a JSON string) and complete the job.
  await updateJob(job_id, {
    status: 'completed',
    transcription: JSON.stringify(transcription),
    completed_at: new Date().toISOString(),
  });

  console.log(`[worker 2] ${job_id} completed → ${chunk_count} chunks merged (${transcription.segments.length} segments)`);
}

// ── Start the worker ────────────────────────────────────────────────────────
// It listens on the chunk_processing queue and runs transcribeChunk for each chunk.
// concurrency 1 = one chunk at a time, so the chunks are done in order
// (BullMQ hands out entries first in, first out), and the Blackbox isn't overloaded.
const worker = new Worker('chunk_processing', transcribeChunk, {
  connection: workerRedis,
  concurrency: 1,
});

console.log('[worker 2] waiting for chunks on chunk_processing');

// A chunk failed (transcribeChunk threw). BullMQ retries it until the attempts run out;
// only after the last attempt do we mark the chunk, and its job, as failed
// (the job can never be completed without this chunk).
worker.on('failed', async (queueJob, err) => {
  const { chunk_job_id, job_id } = queueJob.data;
  const attempts_left = queueJob.opts.attempts - queueJob.attemptsMade;
  console.error(`[worker 2] ${chunk_job_id} failed (${attempts_left} attempts left): ${err.message}`);

  if (attempts_left <= 0) {
    try {
      await updateChunk(chunk_job_id, { status: 'failed', error: err.message });
      await updateJob(job_id, { status: 'failed', stage: 'transcribe', error: `${chunk_job_id}: ${err.message}` });
    } catch (e) {
      console.error(`[worker 2] could not mark chunk/job failed: ${e.message}`);
    }
  }
});

// Ctrl+C (or a restart from `node --watch`): let the current chunk finish, then exit.
async function shutdown() {
  console.log('[worker 2] shutting down');
  await worker.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
