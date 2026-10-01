# Transcription Pipeline: notes for Claude

Take-home assignment: uploaded audio → transcript with per-segment timestamps. It is built piece by piece, and the user checks each step before moving on. **README.md explains the architecture and should be kept up to date when it changes.**

## Code style (user preference)
- **Plain JavaScript (ESM), no TypeScript.** Relative imports end in `.js`.
- Keep it simple and readable. Avoid extra layers and abstractions; every file has a short comment explaining its role.
- Every error uses the shape `{error: {code, message}}`. JSON keys are snake_case.

## Commands
```
docker compose up -d   # Redis :6379 + RedisInsight :5540
npm run dev            # node --watch src/server.js, port 3000
```
The user often has `npm run dev` running on :3000. Test on another port (`PORT=3007 node src/server.js`), and only clean up test data you created yourself.

## Folder structure (chosen by the user; keep it)
- `src/server.js`: Express app, mounts `/jobs`, JSON 404, the error handler last, listen. `src/config.js`: PORT, UPLOAD_DIR (`storage/uploads`), MAX_UPLOAD_MB (500), REDIS_URL.
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
- `src/services/jobs.js`: job record hash `job:<job_id>` = `job_id, status, file_path, original_name, created_at, updated_at`. `createJob` / `getJob` / `deleteJob`.
- `src/redis/redis.js`: one shared ioredis connection (`enableOfflineQueue: false`, so it fails fast when Redis is down). `src/redis/job-queue.js`: BullMQ queue `job_processing` (3 attempts, exponential backoff).
- The status lives in the job record, never in the queue payload.
- The queue entry's BullMQ name is `process_audio` (renamed from `standardise`, which in RedisInsight looked like a status). Job names must never look like a status value.
- Statuses are past tense: each one means that step has *finished* (`standardised` = the WAV exists). While worker 1 is still converting, the status stays `queued`. Don't add a `started` status, because it's not in the submitted answers. To show that a worker has picked a job up, set `started_at` on the job record instead (worker 1, not built yet).
- Every file starts with a header comment block (what it does, what uses it). Keep comments explaining *what each part does*.

## Pipeline vocabulary (must match the user's submitted design answers)
- `job_id`, `chunk_job_id`;
- queues `job_processing` / `chunk_processing`;
- service worker 1 (standardise + chunk) / service worker 2 (transcribe);
- Transcribing Blackbox (faster-whisper);
- statuses `queued → standardised → chunked → transcribing → completed | failed` (failed carries `stage` + `error`). The Part 1 notes say a new job's status is `'started'`; the user decided (2026-10-01) to keep `queued` to match the submitted answers. Don't change it;
- the /status endpoint.


## Roadmap
1. ✅ Upload → job record → job_processing queue → /status
2. Service worker 1: ffprobe validation, ffmpeg standardise to 16 kHz mono WAV, silence/VAD chunking → chunk_processing (ffmpeg isn't installed yet: `brew install ffmpeg`)
3. Transcribing Blackbox (faster-whisper service) + service worker 2, with offsets from each chunk's absolute start
4. Merge → `completed`; /status returns `language, duration, text, segments`
