// ─────────────────────────────────────────────────────────────────────────────
// jobs.controller.js: the /jobs endpoints.
//
//   POST /jobs                  receive an audio file, create a job, reply 202 { job_id, status }
//   GET  /jobs/:job_id/status   the /status endpoint the client polls with its job_id
//
// The controller only coordinates the steps; the actual work lives in:
//   utils/upload.js     saving the file to disk
//   services/jobs.js    the job record (status) in Redis
//   redis/job-queue.js  the job_processing queue
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { saveAudioFile } from '../utils/upload.js';
import { jobQueue } from '../redis/job-queue.js';
import { createJob, deleteJob, getJob } from '../services/jobs.js';

export const jobsRouter = Router();

// ── POST /jobs ──────────────────────────────────────────────────────────────
// check the request → save the file → create the job record → queue the job → 202
jobsRouter.post('/', async (req, res) => {
  // 1. Only multipart/form-data is allowed (that's how browsers and curl send files).
  //    Anything else (JSON, plain text, no body) gets 415 Unsupported Media Type.
  if (!req.is('multipart/form-data')) {
    return res.status(415).json({
      error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Content-Type must be multipart/form-data' },
    });
  }

  // 2. Save the audio file to storage/uploads/.
  //    An invalid upload (too big, 2 files, not audio) throws here, and the error handler
  //    middleware replies 413 / 400 / 415. A request without any file gets 400.
  const file = await saveAudioFile(req, res);
  if (!file) {
    return res.status(400).json({
      error: { code: 'FILE_REQUIRED', message: 'Attach an audio file as multipart/form-data' },
    });
  }

  // A new id for this job. It is used for the job record, the queue entry and the /status URL.
  const job_id = randomUUID();

  try {
    // 3. Create the job record with status "queued". This is what /status returns.
    //    It's written before the queue entry, so a worker never picks up a job without a record.
    await createJob({ job_id, file_path: file.path, original_name: file.originalname });

    // 4. Add the job to the job_processing queue for service worker 1.
    //    'process_audio' is just a label for the kind of work (it is NOT the job's status;
    //    the status lives in the job record). The object is the data the worker receives,
    //    and jobId makes BullMQ use our job_id as its id too.
    await jobQueue.add('process_audio',{ job_id, file_path: file.path }, { jobId: job_id });
  } catch (err) {
    // Step 3 or 4 failed, almost always because Redis is down.
    // Undo both so nothing is left half-created (no record or file without a queued job),
    // and tell the client to try again later.
    console.error(`could not create job ${job_id}: ${err.message}`);
    await deleteJob(job_id).catch(() => {});
    await fs.unlink(file.path).catch(() => {});
    return res.status(503).json({
      error: { code: 'QUEUE_UNAVAILABLE', message: 'Could not queue the job, please retry later' },
    });
  }

  // 5. Reply 202 Accepted: "got it, the work happens later".
  //    The client keeps the job_id and polls the URL in the Location header for the status.
  res.status(202).location(`/jobs/${job_id}/status`).json({ job_id, status: 'queued' });
});

// ── GET /jobs/:job_id/status ────────────────────────────────────────────────
// Look up the job record and return its current status (404 for an unknown job_id).
jobsRouter.get('/:job_id/status', async (req, res) => {
  const job = await getJob(req.params.job_id);
  if (!job) {
    return res.status(404).json({
      error: { code: 'JOB_NOT_FOUND', message: `No job with id "${req.params.job_id}"` },
    });
  }

  // Return only the fields the client needs (file_path is internal).
  // Fields appear as the job moves along (JSON leaves out the ones not set yet):
  // started_at once service worker 1 picks the job up, duration_sec and chunk_count
  // once it is chunked, and stage and error only when the job has failed.
  res.json({
    job_id: job.job_id,
    status: job.status,
    original_name: job.original_name,
    created_at: job.created_at,
    started_at: job.started_at,
    updated_at: job.updated_at,
    // Redis stores every value as text, so turn these two back into numbers.
    duration_sec: job.duration_sec && Number(job.duration_sec), // length of the audio in seconds
    chunk_count: job.chunk_count && Number(job.chunk_count), //    how many chunks it was cut into
    stage: job.stage,
    error: job.error,
  });
});
