# Transcription Pipeline: notes for Claude

Take-home assignment: uploaded audio → transcript with per-segment timestamps.

**Status (2026-10-02): complete.** All four parts (1–4) are built and validated end to end.

- **README.md** is the human-facing explanation (architecture, diagrams, API, decisions). Keep it up to date when anything changes.
- **README §10 "Design decisions"** lists every deviation from the task notes; add to it when a new one is made.
- **README §11** lists possible improvements.

## How the user works
- They build piece by piece and check each step. **Propose a design and confirm it before building.**
- Keep proposals small. They rejected a plan as "too many changes" and prefer the simplest fix that works: e.g. one config value instead of a planner change, or a simple "all chunks completed?" check instead of reordering worker 1.
- They want explanations with concrete examples and timelines from their own data.
- After a change, update README.md and CLAUDE.md.

## Code style (user preference)
- **Plain JavaScript (ESM), no TypeScript.** Relative imports end in `.js`.
- Keep it simple and readable, with no extra layers or abstractions.
- Routes and workers are written as **linear, numbered steps**; the user prefers this to middleware chains.
- Every file starts with a header comment block (what it does, what uses it), and comments explain what each part does.
- Errors use the shape `{error: {code, message}}`. JSON keys and Redis fields are snake_case.

## Commands
```
docker compose up -d   # Redis :6379 + RedisInsight :5540 + Transcribing Blackbox :8000 (built from blackbox/)
npm run dev            # concurrently: api + worker:1 + worker:2 (three processes, logs [api]/[worker1]/[worker2])
npm run api            # node --watch src/server.js, port 3000
npm run worker:1       # node --watch src/workers/job-processing.worker.js (service worker 1)
npm run worker:2       # node --watch src/workers/chunk-processing.worker.js (service worker 2)
npm start              # all three without --watch
```
- The user wanted one command to start everything. The API and the workers stay **separate processes**; never import a worker into server.js.
- Requires ffmpeg (`brew install ffmpeg`, installed), Docker, and Node 20 (built-in `fetch`/`FormData`). Host Python is 3.9, so the Blackbox runs in Docker.

### Testing rules (important)
- **Use a separate setup.** The user often has `npm run dev` running on :3000, with live workers on **Redis db 0**, and those workers process every waiting job (deleting the originals). Test on another port **and** another database: `PORT=3007 REDIS_URL=redis://localhost:6379/1 npm run dev`. Afterwards run `docker compose exec redis redis-cli -n 1 FLUSHDB`.
- **Delete only test data you created.** Remove only your own job ids' folders under `storage/{standardised,chunks,transcripts}`. zsh aborts the whole command when a glob has no match, so avoid globs in `rm`.
- **Stop only your own processes**, by PID (`pgrep -P <your shell pid> -f concurrently`). Never `pkill -f "concurrently ..."`: it once killed the user's dev server.
- **Ask before touching shared state.** Before starting a worker, check the queues (`LLEN bull:job_processing:wait`, `bull:chunk_processing:wait`). Ask before stopping the shared Blackbox container (check that db 0's chunk queues are idle).
- **Test files:** `../audio.mp3` (690 s of fast English speech, 22 chunks) and `../mehmaan.mp3` (a 374 s song, almost no pauses). A short speech clip can be made with `say -o x.aiff "…"`, then ffmpeg it to WAV.

## The pipeline (one file's journey)
| Step | Who | What | Job status |
|---|---|---|---|
| 1 | API `POST /jobs` | save the upload, `createJob`, `jobQueue.add('process_audio')`, reply 202 | `queued` |
| 2 | Worker 1 | ffmpeg → 16 kHz mono WAV, delete the original | `standardised` |
| 3 | Worker 1 | silencedetect → `planChunks` → cut, `createChunk`, `chunkQueue.add('transcribe_chunk')` per chunk | `chunked` |
| 4 | Worker 2 | per chunk: Blackbox → offset (+`start_sec`) → `storage/transcripts/<job_id>/NNN.json` | `transcribing` |
| 5 | Worker 2 | all chunks completed → `mergeTranscripts` → job `transcription` | `completed` |
| 6 | API `GET /jobs/:job_id/status` | returns the record, including `transcription` | |

A failure after 3 attempts gives `failed` + `stage` (`standardise` / `chunk` / `transcribe`) + `error`.

## Files (folder structure chosen by the user; keep it)
- **`src/server.js`:** the Express app. It mounts `/jobs`, returns a JSON 404, adds the error handler last, then listens.
- **`src/config.js`:** every setting with an env override:
  - `PORT` 3000, `REDIS_URL`, `MAX_UPLOAD_MB` 500;
  - folders: `UPLOAD_DIR` `storage/uploads`, `STANDARDISED_DIR`, `CHUNKS_DIR`, `TRANSCRIPTS_DIR`;
  - chunking: `CHUNK_TARGET_SEC` 30, `CHUNK_MAX_SEC` 60, `CHUNK_MIN_SEC` 10;
  - pause detection: `SILENCE_NOISE_DB` -30, `SILENCE_MIN_SEC` **0.2**;
  - Blackbox: `BLACKBOX_URL` `http://localhost:8000`, `BLACKBOX_TIMEOUT_MS` 300000.
- **`src/controllers/jobs.controller.js`:**
  - **`POST /jobs`** (renamed from `/jobs/upload-file` to match the submitted answers):
    1. not multipart → 415;
    2. `saveAudioFile`; no file → 400;
    3. `createJob`;
    4. `jobQueue.add('process_audio', {job_id, file_path}, {jobId: job_id})`;
    5. 202 + Location.

    If step 3 or 4 fails, delete the record and the file, then 503.
  - **`GET /jobs/:job_id/status`:** 200 or 404. Returns:
    - `job_id, status, original_name, created_at, started_at, updated_at, completed_at`;
    - `duration_sec` and `chunk_count`, converted with `Number()` because Redis stores text;
    - `stage` and `error` when failed;
    - `transcription`, run through `JSON.parse`.

    Missing fields are left out.
- **`src/utils/upload.js`:** `saveAudioFile(req, res)`, a Promise wrapper around multer (disk storage, 1 file, `audio/*` only, UUID filenames). Helpers are called from the controller, not mounted as middleware.
- **`src/middlewares/error-handler.middleware.js`:** LIMIT_FILE_SIZE → 413, LIMIT_FILE_COUNT → 400, UNSUPPORTED_FILE_TYPE → 415, anything else → 500.
- **`src/services/jobs.js`:** `createJob` / `getJob` / `updateJob(job_id, fields)` (also sets `updated_at`) / `deleteJob`. Job record `job:<job_id>`:
  - from the API: `job_id, status, file_path, original_name, created_at, updated_at`;
  - from worker 1: `started_at, duration_sec, chunk_count`;
  - from worker 2: `transcription` (a JSON string), `completed_at`;
  - on failure: `stage, error`.
- **`src/services/chunks.js`:** `createChunk` / `getChunk` / `updateChunk`. Chunk record `chunk:<chunk_job_id>`:
  - from worker 1: `chunk_job_id, job_id, chunk_index, chunk_path, start_sec, end_sec, status, created_at, updated_at`;
  - from worker 2: `duration_sec, started_at, transcript_path, language` (or `error`).
- **`src/redis/redis.js`:** two connections.
  - `redis` is shared and fails fast (`enableOfflineQueue: false`).
  - `workerRedis` uses `maxRetriesPerRequest: null` and `lazyConnect`, which BullMQ Workers need for their blocking commands.
- **`src/redis/job-queue.js`, `src/redis/chunk-queue.js`:** the BullMQ queues `job_processing` and `chunk_processing` (3 attempts, exponential backoff of 5 s then 10 s, `removeOnComplete` 1000, `removeOnFail` 5000).
- **`src/utils/ffmpeg.js`:** everything goes through `run(program, args)` (`child_process.spawn`; ENOENT → "not installed"). Decision: plain spawn, **not** fluent-ffmpeg, which is deprecated. Functions:
  - `standardiseAudio` (`-vn -ac 1 -ar 16000 -c:a pcm_s16le`);
  - `getDuration` (ffprobe);
  - `detectSilences(path, {noise_db, min_sec})` (silencedetect, stderr parsed into `[{start, end}]`);
  - `cutChunk` (`-ss/-to`, re-encoded so it's sample-accurate).
- **`src/utils/chunking.js`:** `planChunks(duration, silences, {target_sec, max_sec, min_sec})`, pure arithmetic.
  - It cuts at the midpoint of the pause closest to the target, among pauses in [start+min, start+max].
  - With no pause in range, it hard-cuts at start+max.
  - Whatever is left at the end (≤ max) becomes the last chunk.
- **`src/utils/blackbox.js`:** `transcribe(chunk_path)` POSTs the WAV as `FormData` field `file` to `${BLACKBOX_URL}/transcribe`, with `AbortSignal.timeout`. Errors are readable: unreachable, timeout, or non-200 with the reply body.
- **`src/utils/transcript.js`:** two pure functions.
  - `offsetTimestamps(result, offset_sec)`: + offset on every segment and word time, rounded to ms; null stays null; adds `offset_sec`.
  - `mergeTranscripts(transcripts, duration)`: returns `{language (majority), duration, text (segment texts joined), segments: [{id, start, end, text}]}`, with no words.
- **`src/workers/job-processing.worker.js` (service worker 1)**, concurrency 1, `processAudio`:
  1. `getJob`; return if it's already `chunked`; set `started_at` once. Steps 2–4 run only when the status is `queued`.
  2. `standardiseAudio` → `storage/standardised/<job_id>.wav`.
  3. `updateJob` status `standardised`, `file_path` → the WAV.
  4. Delete the original, only after the record points at the WAV.
  5. `getDuration` + `detectSilences`.
  6. `planChunks`.
  7. For each chunk: `cutChunk` → `storage/chunks/<job_id>/NNN.wav`, `createChunk` (`not_started`), and `chunkQueue.add('transcribe_chunk', {chunk_job_id, job_id, chunk_path, start_sec, end_sec}, {jobId: chunk_job_id})`. The id `chunk_job_id = ${job_id}-NNN` is predictable, so a retry creates no duplicates.
  8. `updateJob` status `chunked`, `chunk_count`, `duration_sec`.

  On the last failed attempt, `stage` is `standardise` (the record is still `queued`) or `chunk` (it's `standardised`). The standardised WAV is kept.
- **`src/workers/chunk-processing.worker.js` (service worker 2)**, concurrency 1 (FIFO, so chunks 000, 001, … in order), `transcribeChunk`:
  1. `getChunk`. If it's already `completed` (a retry), go straight to step 7.
  2. `updateChunk` status `processing`, `duration_sec`, `started_at`. Also, if the job is `chunked`, move it to `transcribing`. Only that transition is allowed, so the status never goes backwards. Worker 1 often writes `chunked` just after chunk 000 has started, so in that case the next chunk sets `transcribing`.
  3. `transcribe(chunk_path)`.
  4. `offsetTimestamps(result, start_sec)`.
  5. Write `storage/transcripts/<job_id>/NNN.json`, with word timings, on the whole file's timeline.
  6. `updateChunk` status `completed`, `transcript_path`, `language`.
  7. `finishJobIfDone(job_id)`: `getJob`, and skip if it's already `completed`. If **all** `chunk_count` chunk records are `completed`, read their JSONs in order, run `mergeTranscripts`, then `updateJob` status `completed` with `transcription` and `completed_at`.

  On the last failed attempt, the chunk becomes `failed` and the job becomes `failed`, with `stage: transcribe` and `error: "<chunk_job_id>: …"`.
- **`blackbox/` (the Transcribing Blackbox):** Python in Docker, service `blackbox` on :8000.
  - `app.py` (FastAPI) loads `whisperx.load_model(WHISPER_MODEL=small, cpu, int8)` once; WhisperX runs faster-whisper.
  - `POST /transcribe`: `load_audio` → `model.transcribe` (language detected per chunk) → `whisperx.align` with a per-language alignment model, cached. If the language has none, `aligned: false`.
  - The reply is `{language, duration_sec, aligned, segments: [{start, end, text, words: [{word, start, end}]}]}`, times relative to the chunk. There's also `GET /health`.
  - `requirements.txt` pins whisperx 3.8.6 (Python ≥ 3.10). The image uses CPU-only torch, and models are cached in the `hf-cache` volume.

## Decisions made with the user (don't undo)
- **Statuses:**
  - A new job is `queued`, not `started`, to match the submitted answers. Worker 1 sets `started_at` instead.
  - Statuses are past tense; each one means that step is finished.
  - Never add a status the submitted answers don't have.
- **The status lives in records** (`job:*`, `chunk:*`), never in queue payloads. Queue entry names (`process_audio`, `transcribe_chunk`) must never look like a status.
- **Spec "updates the job_processing queue's status"** is implemented as the *job record's* status, because the queue entry finishes when worker 1 is done.
- **Pause detection:** silencedetect, not Silero. Chunks aim for 30 s, max 60 s. `SILENCE_MIN_SEC` was lowered from 0.5 to 0.2 because fast speech had no 0.5 s pauses, which caused hard cuts that could split words. Splitting sentences is fine, because the merge rejoins them.
- **Blackbox:** an HTTP service in Docker (the model loads once, Node only needs `fetch`, it scales separately on a GPU). It uses the `small` model, int8, on CPU.
- **Merge trigger:** this is the user's design. After every completed chunk, check whether all of the job's chunks are completed; if so, and the job isn't completed yet, merge. Worker 1 was **not** reordered (I proposed it; the user rejected it as too much).
- **/status:** the transcription contains **segments only** (the user's choice). Word timings stay in the per-chunk files.
- **Files are kept** after completion (the standardised WAV, chunks and chunk JSONs). Cleanup is a possible improvement.
- **Two documented nuances in worker 2** versus the spec wording:
  - It skips only `completed` chunks, so a chunk left in `processing` by a crash is retried.
  - A chunk retried after the backoff can finish after later chunks. That's harmless, because the times are absolute and the merge goes in `chunk_index` order.

## Pipeline vocabulary (must match the user's submitted design answers)
- **Ids:** `job_id`, `chunk_job_id`.
- **Queues:** `job_processing` / `chunk_processing`, with entry names `process_audio` / `transcribe_chunk`.
- **Workers:** service worker 1 (standardise + chunk) and service worker 2 (transcribe + merge).
- **Blackbox:** the Transcribing Blackbox (faster-whisper + WhisperX).
- **Job statuses:** `queued → standardised → chunked → transcribing → completed | failed`.
- **Chunk statuses:** `not_started → processing → completed | failed`.
- **Endpoint:** the /status endpoint. The `transcription` field contains `{language, duration, text, segments}`.

## Scaling notes (discussed with the user; also in README §10)
- In production, the API and the workers would be separate deployments. The workers scale with queue length (KEDA); ffmpeg runs on CPU and the Blackbox on GPU.
- Local `file_path`s only work because everything shares one disk. They'd become object-storage URLs (the spec's "uri (or path)").
- Redis would be a managed service.

## Verification history
- **Part 1:** 415/400/413/202/200/404 verified.
- **Part 2:**
  - A fake mp3 → `failed`/`standardise`.
  - `mehmaan.mp3` → 7 chunks, mostly 60 s hard cuts (music), with lengths summing to 373.97 s.
  - A tone with 2 s pauses → every cut is inside a pause.
- **Part 3:** `audio.mp3` → 22 chunks of 28–33 s.
  - All are English and aligned, and every word has times.
  - The offsets put every time inside its chunk, with no overlaps.
  - No cut splits a word. Before the 0.2 s change it was 16 chunks, 4 of them hard cuts that split sentences.
- **Part 4:**
  - `audio.mp3` → `queued → chunked → transcribing → completed` with no backwards steps: 137 segments, ids 0…136 in time order, 0.211–690.207 s, `/status` ≈ 37 KB.
  - A single-chunk clip → completed.
  - Blackbox stopped → chunk and job `failed`/`transcribe` with the ECONNREFUSED error.
- **Known quirks:**
  - On music, Whisper misdetects the language (`mehmaan.mp3` → "lt") and nothing gets aligned.
  - Whisper can invent a phrase at a chunk's start ("Thank you." at chunk 004 of `audio.mp3`).
  - Music still gets 60 s hard cuts.
