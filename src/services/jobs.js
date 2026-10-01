// ─────────────────────────────────────────────────────────────────────────────
// services/jobs.js: read and write job records.
//
// A job record is where a job's status is kept. Each job is one Redis hash:
//   key:   job:<job_id>
//   value: { job_id, status, file_path, original_name, created_at, updated_at }
//
// Why not keep the status in the queue? The queue only delivers work to a worker,
// and BullMQ deletes jobs once they finish. The job record stays.
// The workers will update its status (queued → standardised → chunked → transcribing
// → completed / failed), and GET /jobs/:job_id/status reads it.
// ─────────────────────────────────────────────────────────────────────────────

import { redis } from '../redis/redis.js';

// Create the record for a new upload. Every job starts as "queued".
export async function createJob({ job_id, file_path, original_name }) {
  const now = new Date().toISOString();
  const job = {
    job_id,
    status: 'queued',
    file_path,
    original_name,
    created_at: now,
    updated_at: now,
  };
  await redis.hset(`job:${job_id}`, job); // HSET writes all fields into the hash
  return job;
}

// Fetch a job record. Returns null when no job has this id
// (Redis returns an empty object for a key that doesn't exist).
export async function getJob(job_id) {
  const job = await redis.hgetall(`job:${job_id}`);
  return job.job_id ? job : null;
}

// Remove a job record. Used to clean up when queueing the job fails.
export async function deleteJob(job_id) {
  await redis.del(`job:${job_id}`);
}
