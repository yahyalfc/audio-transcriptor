// ─────────────────────────────────────────────────────────────────────────────
// services/chunks.js: read and write chunk records.
//
// A chunk record keeps the status of one chunk, just like a job record does for
// a whole job. Each chunk is one Redis hash:
//   key:   chunk:<chunk_job_id>        e.g. chunk:6ff017f4-...-002
//   value: { chunk_job_id, job_id, chunk_index, chunk_path, start_sec, end_sec,
//            status, created_at, updated_at }
//
// Status: "not_started" when created by service worker 1. Service worker 2
// (next part) will move it forward as it transcribes the chunk.
// As with jobs, the status lives here and not in the queue entry, because BullMQ
// deletes queue entries once they're done.
// ─────────────────────────────────────────────────────────────────────────────

import { redis } from '../redis/redis.js';

// Create the record for a new chunk. Every chunk starts as "not_started".
// Writing it again with the same chunk_job_id (on a retry) simply overwrites it.
export async function createChunk({ chunk_job_id, job_id, chunk_index, chunk_path, start_sec, end_sec }) {
  const now = new Date().toISOString();
  const chunk = {
    chunk_job_id,
    job_id,
    chunk_index,
    chunk_path,
    start_sec,
    end_sec,
    status: 'not_started',
    created_at: now,
    updated_at: now,
  };
  await redis.hset(`chunk:${chunk_job_id}`, chunk);
  return chunk;
}

// Fetch a chunk record, or null when there is none with this id.
export async function getChunk(chunk_job_id) {
  const chunk = await redis.hgetall(`chunk:${chunk_job_id}`);
  return chunk.chunk_job_id ? chunk : null;
}
