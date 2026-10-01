# Transcription Pipeline: notes for Claude

Take-home assignment: uploaded audio → transcript with per-segment timestamps. It is built piece by piece, and the user checks each step before moving on. **README.md explains the architecture and should be kept up to date when it changes.** Its section 9, "Design decisions", lists every deviation from the task notes; add to it when a new one is made.

**Status (2026-10-01):** Part 1 (upload → queue → /status) ✅ and Part 2 (worker 1: standardise + chunk → chunk_processing) ✅, both validated against the user's spec. **Next: Part 3** (service worker 2 + Transcribing Blackbox). The user works in small steps: propose a design and confirm it before building.

## Code style (user preference)
- **Plain JavaScript (ESM), no TypeScript.** Relative imports end in `.js`.
- Keep it simple and readable. Avoid extra layers and abstractions; every file has a short comment explaining its role.
- Every error uses the shape `{error: {code, message}}`. JSON keys are snake_case.

## Commands
```
docker compose up -d   # Redis :6379 + RedisInsight :5540
npm run dev            # concurrently: `npm run api` + `npm run worker` (two separate processes, logs prefixed [api]/[worker])
npm run api            # node --watch src/server.js, port 3000
npm run worker         # node --watch src/workers/job-processing.worker.js (service worker 1)
npm start              # API + worker without --watch
```
The user wanted one command to start everything. The API and the worker stay **separate processes**; don't import the worker into server.js.
Requires ffmpeg (`brew install ffmpeg`, installed).
The user often has `npm run dev` (API + worker) running on :3000. Their worker is then live on Redis db 0 and will process your test jobs too. Test on another port **and** another Redis database: `PORT=3007 REDIS_URL=redis://localhost:6379/1 npm run dev`, then `redis-cli -n 1 FLUSHDB` afterwards. Only clean up test data you created yourself. Running a worker processes **every** waiting job in its queue (and deletes their originals), so check `LRANGE bull:job_processing:wait 0 -1` and ask the user before starting a worker when the queue has jobs that aren't yours.

## Folder structure (chosen by the user; keep it)
- `src/server.js`: Express app, mounts `/jobs`, JSON 404, the error handler last, listen. `src/config.js`: PORT, UPLOAD_DIR (`storage/uploads`), STANDARDISED_DIR (`storage/standardised`), CHUNKS_DIR (`storage/chunks`), CHUNK_TARGET_SEC 30 / CHUNK_MAX_SEC 60 / CHUNK_MIN_SEC 10, SILENCE_NOISE_DB -30 / SILENCE_MIN_SEC 0.5, MAX_UPLOAD_MB (500), REDIS_URL.
- `src/controllers/jobs.controller.js`: the endpoints, written as a linear sequence of steps (the user prefers this to middleware chains):
  - `POST /jobs` (renamed from `/jobs/upload-file` to match the submitted answers):
    1. not multipart → 415;
    2. `await saveAudioFile(req, res)`; no file → 400;
    3. `createJob` (status `queued`);
    4. `jobQueue.add('process_audio', {job_id, file_path}, {jobId: job_id})`;
    5. 202 `{job_id, status}` + Location.
    If step 3 or 4 fails: delete the record and the file, then 503.
  - `GET /jobs/:job_id/status`: `getJob`, 200, or 404.
- `src/utils/upload.js`: `saveAudioFile(req, res)`, a Promise wrapper around multer (diskStorage, `.any()`, 1 file, `audio/*` only, random-UUID filenames). Helpers go in utils/ and are called from the controller, not mounted as middleware.
- `src/middlewares/error-handler.middleware.js`: LIMIT_FILE_SIZE → 413, LIMIT_FILE_COUNT → 400, UNSUPPORTED_FILE_TYPE → 415, otherwise 500.
- `src/services/jobs.js`: job record hash `job:<job_id>` = `job_id, status, file_path, original_name, created_at, updated_at` (+ `started_at`, `duration_sec`, `chunk_count`, and `stage, error` when failed). `createJob` / `getJob` / `updateJob(job_id, fields)` / `deleteJob`.
- `src/services/chunks.js`: chunk record hash `chunk:<chunk_job_id>` = `chunk_job_id, job_id, chunk_index, chunk_path, start_sec, end_sec, status` (`not_started`), `created_at, updated_at`. `createChunk` / `getChunk`. As with jobs, the chunk status lives in the record, not in the queue entry.
- `src/redis/redis.js`: `redis`, the shared ioredis connection (`enableOfflineQueue: false`, so it fails fast when Redis is down), and `workerRedis` (`maxRetriesPerRequest: null`, `lazyConnect`), which BullMQ Workers must use for their blocking commands. `src/redis/job-queue.js`: BullMQ queue `job_processing` (3 attempts, exponential backoff). `src/redis/chunk-queue.js`: queue `chunk_processing`, with the same options.
- `src/utils/ffmpeg.js`: all calls go through `run(program, args)` (`child_process.spawn`, resolves `{stdout, stderr}`, rejects with stderr; ENOENT → "not installed"). Decision: plain spawn, **not** fluent-ffmpeg, which is deprecated.
  - `standardiseAudio(in, out)`: `-vn -ac 1 -ar 16000 -c:a pcm_s16le`;
  - `getDuration` (ffprobe);
  - `detectSilences(path, {noise_db, min_sec})`: silencedetect, with the stderr parsed to `[{start, end}]`;
  - `cutChunk(in, out, start, end)`: `-ss/-to`, re-encoded to pcm so it's sample-accurate.
- `src/utils/chunking.js`: `planChunks(duration, silences, {target_sec, max_sec, min_sec})`, pure arithmetic. It cuts at the midpoint of the pause closest to target, among pauses in [start+min, start+max]; with no pause in range it hard-cuts at start+max. The user chose silencedetect (not Silero) and a 30 s target / 60 s max.
- `src/workers/job-processing.worker.js`: **service worker 1**, a separate process. A BullMQ Worker on `job_processing` (concurrency 1) runs `processAudio`, a linear sequence of steps like the controller:
  1. `getJob`; return if it's already `chunked`; set `started_at` on the first attempt. Steps 2–4 run only when the status is `queued`, so a retry skips finished work.
  2. `standardiseAudio` → `storage/standardised/<job_id>.wav`;
  3. `updateJob` status `standardised`, `file_path` → the WAV;
  4. delete the original upload. It's deleted only after the record points at the WAV.
  5. `getDuration` + `detectSilences`;
  6. `planChunks`;
  7. for each chunk:
     - `chunk_job_id = ${job_id}-000`, which is predictable, so a retry gives no duplicates (BullMQ ignores a duplicate jobId, and HSET overwrites);
     - `cutChunk` → `storage/chunks/<job_id>/000.wav`;
     - `createChunk` (`not_started`);
     - `chunkQueue.add('transcribe_chunk', {chunk_job_id, job_id, chunk_path, start_sec, end_sec}, {jobId: chunk_job_id})`. `start_sec` is there so worker 2 can offset the timestamps.
  8. `updateJob` status `chunked`, `chunk_count`, `duration_sec`.
  After the last attempt fails, `worker.on('failed')` sets `status failed`, `stage` (`standardise` if the record is still `queued`, `chunk` if it's `standardised`) and `error`. SIGINT/SIGTERM → `worker.close()`.
  The standardised WAV is kept after chunking; the spec doesn't ask for it to be deleted.
- `GET /status` also returns `started_at`, `duration_sec`/`chunk_count` (converted to numbers, because Redis stores text), and `stage`/`error` when failed. Fields that are missing are left out.
- The status lives in the job record, never in the queue payload.
- The queue entry's BullMQ name is `process_audio` (renamed from `standardise`, which in RedisInsight looked like a status). Job names must never look like a status value.
- Statuses are past tense: each one means that step has *finished* (`standardised` = the WAV exists). While worker 1 is still converting, the status stays `queued`. Don't add a `started` status, because it's not in the submitted answers. Worker 1 sets `started_at` instead, to show that a job was picked up.
- Every file starts with a header comment block (what it does, what uses it). Keep comments explaining *what each part does*.

## Pipeline vocabulary (must match the user's submitted design answers)
- `job_id`, `chunk_job_id`;
- queues `job_processing` / `chunk_processing`;
- service worker 1 (standardise + chunk) / service worker 2 (transcribe);
- queue entry names `process_audio` (job_processing) / `transcribe_chunk` (chunk_processing);
- chunk record status starts as `not_started` (from the Part 2 spec);
- Transcribing Blackbox (faster-whisper);
- statuses `queued → standardised → chunked → transcribing → completed | failed` (failed carries `stage` + `error`). The Part 1 notes say a new job's status is `'started'`; the user decided (2026-10-01) to keep `queued` to match the submitted answers. Don't change it;
- the /status endpoint.


## Scaling notes (discussed with the user; also in README §9)
- In production, the API and the workers are separate deployments: workers scale with queue length, ffmpeg on CPU, the Blackbox on GPU.
- Local `file_path`s in queue entries only work because everything shares one disk. In production they'd become object-storage URLs (the spec's "uri (or path)").

## Roadmap
1. ✅ Upload → job record → job_processing queue → /status
2. Service worker 1:
   - ✅ 2a: standardise to 16 kHz mono WAV, delete the original (verified with mehmaan.mp3: the output is pcm_s16le 16 kHz mono, same duration; a fake mp3 → `failed` after 3 attempts)
   - ✅ 2b: silencedetect chunking → `chunk_processing`. Verified:
     - mehmaan.mp3 (a song with almost no pauses) → 7 chunks, mostly 60 s fallback cuts, with the durations summing to 373.97 s;
     - a tone with 2 s pauses → every cut inside a pause;
     - a fake mp3 → failed/standardise.
3. Transcribing Blackbox (faster-whisper service) + service worker 2, with offsets from each chunk's absolute start
4. Merge → `completed`; /status returns `language, duration, text, segments`
