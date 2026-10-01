# Transcription Pipeline: notes for Claude

Take-home assignment: uploaded audio → transcript with per-segment timestamps. It is built piece by piece, and the user checks each step before moving on. **README.md explains the architecture and should be kept up to date when it changes.**

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
- `src/server.js`: Express app, mounts `/jobs`, JSON 404, the error handler last, listen. `src/config.js`: PORT, UPLOAD_DIR (`storage/uploads`), STANDARDISED_DIR (`storage/standardised`), MAX_UPLOAD_MB (500), REDIS_URL.
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
- `src/services/jobs.js`: job record hash `job:<job_id>` = `job_id, status, file_path, original_name, created_at, updated_at` (+ `started_at`, and `stage, error` when failed). `createJob` / `getJob` / `updateJob(job_id, fields)` / `deleteJob`.
- `src/redis/redis.js`: `redis`, the shared ioredis connection (`enableOfflineQueue: false`, so it fails fast when Redis is down), and `workerRedis` (`maxRetriesPerRequest: null`, `lazyConnect`), which BullMQ Workers must use for their blocking commands. `src/redis/job-queue.js`: BullMQ queue `job_processing` (3 attempts, exponential backoff).
- `src/utils/ffmpeg.js`: `standardiseAudio(in, out)` = `ffmpeg -y -i in -vn -ac 1 -ar 16000 -c:a pcm_s16le out` via `child_process.spawn` (decision: plain spawn, **not** fluent-ffmpeg, which is deprecated). It rejects with ffmpeg's stderr; ENOENT → "ffmpeg not installed".
- `src/workers/job-processing.worker.js`: **service worker 1**, a separate process. A BullMQ Worker on `job_processing` (concurrency 1) runs `processAudio`, a linear sequence of steps like the controller:
  1. `getJob`; skip if it's already `standardised`; set `started_at` on the first attempt;
  2. `standardiseAudio` → `storage/standardised/<job_id>.wav` (`config.standardisedDir`);
  3. `updateJob` status `standardised`, `file_path` → the WAV;
  4. delete the original upload. It's deleted only after the record points at the WAV.
  After the last attempt fails, `worker.on('failed')` sets `status failed, stage standardise, error`. SIGINT/SIGTERM → `worker.close()`.
  Chunking (VAD → `chunk_processing`) will be added to this same worker next.
- `GET /status` also returns `started_at`, and `stage`/`error` when failed (fields that are missing are left out).
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
2. Service worker 1:
   - ✅ 2a: standardise to 16 kHz mono WAV, delete the original (verified with mehmaan.mp3: the output is pcm_s16le 16 kHz mono, same duration; a fake mp3 → `failed` after 3 attempts)
   - next, 2b: silence/VAD chunking → `chunk_processing` entries `{chunk_job_id, job_id, chunk path}` with chunk status `not_started` (VAD method and chunk length still to be decided with the user)
3. Transcribing Blackbox (faster-whisper service) + service worker 2, with offsets from each chunk's absolute start
4. Merge → `completed`; /status returns `language, duration, text, segments`
