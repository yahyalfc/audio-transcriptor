# Transcription Pipeline: notes for Claude

Take-home assignment: uploaded audio → transcript with per-segment timestamps. It is built piece by piece, and the user checks each step before moving on. **README.md explains the architecture and should be kept up to date when it changes.** Its section 10, "Design decisions", lists every deviation from the task notes; add to it when a new one is made.

**Status (2026-10-01):** Part 1 (upload → queue → /status) ✅ and Part 2 (worker 1: standardise + chunk → chunk_processing) ✅, both validated against the user's spec. Part 3 (worker 2 + Transcribing Blackbox, one offset-adjusted transcript JSON per chunk) ✅, validated against the user's spec. **Next: Part 4**: job status `transcribing` / `completed` / failing with `stage: transcribe`, merging the chunk transcripts, and `/status` returning the transcript. The user works in small steps: propose a design and confirm it before building.

## Code style (user preference)
- **Plain JavaScript (ESM), no TypeScript.** Relative imports end in `.js`.
- Keep it simple and readable. Avoid extra layers and abstractions; every file has a short comment explaining its role.
- Every error uses the shape `{error: {code, message}}`. JSON keys are snake_case.

## Commands
```
docker compose up -d   # Redis :6379 + RedisInsight :5540 + Transcribing Blackbox :8000 (built from blackbox/)
npm run dev            # concurrently: api + worker:1 + worker:2 (three processes, logs prefixed [api]/[worker1]/[worker2])
npm run api            # node --watch src/server.js, port 3000
npm run worker:1       # node --watch src/workers/job-processing.worker.js (service worker 1)
npm run worker:2       # node --watch src/workers/chunk-processing.worker.js (service worker 2)
npm start              # all three without --watch
```
The user wanted one command to start everything. The API and the workers stay **separate processes**; don't import a worker into server.js.
Requires ffmpeg (`brew install ffmpeg`, installed).
The user often has `npm run dev` (API + worker) running on :3000. Their worker is then live on Redis db 0 and will process your test jobs too. Test on another port **and** another Redis database: `PORT=3007 REDIS_URL=redis://localhost:6379/1 npm run dev`, then `redis-cli -n 1 FLUSHDB` afterwards. Only clean up test data you created yourself. Running a worker processes **every** waiting job in its queue (and deletes their originals), so check `LRANGE bull:job_processing:wait 0 -1` and ask the user before starting a worker when the queue has jobs that aren't yours.

## Folder structure (chosen by the user; keep it)
- `src/server.js`: Express app, mounts `/jobs`, JSON 404, the error handler last, listen. `src/config.js`: PORT, UPLOAD_DIR (`storage/uploads`), STANDARDISED_DIR (`storage/standardised`), CHUNKS_DIR (`storage/chunks`), CHUNK_TARGET_SEC 30 / CHUNK_MAX_SEC 60 / CHUNK_MIN_SEC 10, SILENCE_NOISE_DB -30 / SILENCE_MIN_SEC 0.2, TRANSCRIPTS_DIR (`storage/transcripts`), BLACKBOX_URL (`http://localhost:8000`), BLACKBOX_TIMEOUT_MS (300000), MAX_UPLOAD_MB (500), REDIS_URL.
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
- `src/services/chunks.js` also has `updateChunk(chunk_job_id, fields)` (mirrors `updateJob`).
- `src/utils/blackbox.js`: `transcribe(chunk_path)` reads the WAV, POSTs `FormData` (field `file`) with Node's built-in `fetch` to `${BLACKBOX_URL}/transcribe` with `AbortSignal.timeout(BLACKBOX_TIMEOUT_MS)` (5 min), and throws a readable error (unreachable / timeout / non-200 with the body).
- `src/workers/chunk-processing.worker.js`: **service worker 2**, a BullMQ Worker on `chunk_processing` with `concurrency: 1` (so chunks are done in FIFO order 000, 001, …). `transcribeChunk`:
  1. `getChunk`; return if it's already `completed`;
  2. `updateChunk` status `processing`, `duration_sec` (end − start), `started_at`;
  3. `transcribe(chunk_path)`;
  4. `offsetTimestamps(result, start_sec)` (`src/utils/transcript.js`, pure): + `start_sec` on every segment/word time, rounded to ms; null stays null; adds `offset_sec`;
  5. write `storage/transcripts/<job_id>/<NNN>.json` (times are on the whole file's timeline);
  6. `updateChunk` status `completed`, `transcript_path`, `language`.
  After the last attempt fails, `on('failed')` sets the chunk to `failed` + `error`. It does **not** touch the job record yet: the job status (`transcribing`, failing the job with `stage: transcribe`) comes with Part 4.
  Two documented nuances vs the spec wording: it skips only `completed` chunks (not "only `not_started`"), so a chunk left in `processing` by a crash is retried; and a failed chunk retries after a 5–10 s backoff while later chunks continue, so "linear" holds on the happy path. That's harmless because times are already absolute and the merge orders by `chunk_index`.
- `blackbox/` (Python, Docker, the `blackbox` service in docker-compose on :8000): `app.py` (FastAPI) loads `whisperx.load_model(WHISPER_MODEL=small, cpu, int8)` once at startup (WhisperX runs faster-whisper). `POST /transcribe` (multipart `file`) → `load_audio` → `model.transcribe` (language detected per chunk) → `whisperx.align` with an alignment model cached per language (none for that language → `aligned: false`). Reply: `{language, duration_sec, aligned, segments: [{start, end, text, words: [{word, start, end}]}]}`, times rounded to ms, unaligned words have null times. `GET /health`. `requirements.txt` pins whisperx 3.8.6 (needs Python ≥ 3.10; the host only has 3.9, which is one reason it runs in Docker). The Dockerfile uses CPU-only torch; the models are cached in the `hf-cache` volume. Decision: an HTTP service rather than spawning Python per chunk (the model loads once, Node only needs `fetch`, it scales separately on GPU).
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
- chunk record status: `not_started` (worker 1) → `processing` → `completed` | `failed` (worker 2);
- Transcribing Blackbox (faster-whisper);
- statuses `queued → standardised → chunked → transcribing → completed | failed` (failed carries `stage` + `error`). The Part 1 notes say a new job's status is `'started'`; the user decided (2026-10-01) to keep `queued` to match the submitted answers. Don't change it;
- the /status endpoint.


## Scaling notes (discussed with the user; also in README §10)
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
3. ✅ Part 3 (validated 2026-10-01; final check on audio.mp3: 22 chunks of 28–33 s, done in order, all aligned, no word split at any cut):
   - ✅ 3a (slice 1): Transcribing Blackbox (Docker, FastAPI, faster-whisper + WhisperX) + service worker 2 → `storage/transcripts/<job_id>/NNN.json` per chunk, chunk status `processing` → `completed`
   - ✅ 3b: time offset adjustment (+`start_sec` on every segment/word). Verified with audio.mp3 (690 s, 16 chunks, en, all aligned): every time falls inside its chunk's [start_sec, end_sec], chunks don't overlap, `offset_sec` = `start_sec`.
   - Fix (user decision): SILENCE_MIN_SEC 0.5 → 0.2. Fast speech (audio.mp3) had no 0.5 s pauses for minutes, so 4 chunks got 60 s hard cuts, which can split a word. At 0.2 s every cut falls between words. The planner is unchanged; the user is fine with sentences being split, since merging rejoins them. Music still gets hard cuts.
   - Known Whisper quirk: it can invent a short phrase at a chunk's start ("Thank you." at chunk 004 of audio.mp3). Not fixed yet.
4. Part 4 (next): job status `transcribing` (worker 2), job `failed` with `stage: transcribe`, merge the chunk JSONs by `chunk_index` → `completed`; /status returns `language, duration, text, segments`
