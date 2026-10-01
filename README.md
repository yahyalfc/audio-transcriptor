# Transcription Pipeline

Upload an audio file and get back a transcript with timestamps for each segment.

The project is built step by step. **What exists so far (Part 1):**
- an upload endpoint that saves the audio file to disk,
- creates a job,
- puts the job on a message queue,
- and lets the client poll the job's status.

The workers that will actually transcribe the audio come in later parts.

---

## 1. The big picture

```mermaid
flowchart LR
    Client([Client<br/>curl / browser])

    subgraph Mac["Your machine"]
        API["Express API<br/>(src/server.js)"]
        Disk[("storage/uploads/<br/>audio files")]
    end

    subgraph Docker["Docker (docker compose)"]
        Redis[("Redis<br/>job records + queue")]
        Insight["RedisInsight<br/>GUI on :5540"]
    end

    Worker1["Service worker 1<br/>(next part)"]

    Client -- "POST /jobs" --> API
    Client -- "GET /jobs/:job_id/status" --> API
    API -- "save file" --> Disk
    API -- "job record + queue entry" --> Redis
    Insight -. "browse keys" .-> Redis
    Redis -. "takes jobs from job_processing" .-> Worker1
    Worker1 -. "reads audio file" .-> Disk

    style Worker1 stroke-dasharray: 5 5
```

There are three running pieces:

| Piece | What it does | How it runs |
|---|---|---|
| **Express API** | Receives uploads, saves files, creates jobs, answers status requests | `npm run dev` on your machine, port 3000 |
| **Redis** | Stores the job records and the `job_processing` queue | Docker container, port 6379 |
| **RedisInsight** | Web UI for looking at what's inside Redis. Optional, just for debugging. | Docker container, http://localhost:5540 |

---

## 2. What happens when a file is uploaded

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant CT as jobs.controller.js
    participant U as utils/upload.js
    participant D as storage/uploads
    participant S as services/jobs.js
    participant Q as redis/job-queue.js
    participant R as Redis

    C->>CT: POST /jobs (multipart/form-data, 1 audio file)
    CT->>CT: not multipart/form-data? → 415
    CT->>U: await saveAudioFile(req, res)
    U->>D: stream the file to disk as <uuid>.mp3
    Note over U: too big → 413, 2 files → 400, not audio → 415<br/>(thrown → error handler middleware)
    U-->>CT: file { path, originalname }  (none → 400)
    CT->>S: createJob({ job_id, file_path, original_name })
    S->>R: HSET job:<job_id>  { status: "queued", ... }
    CT->>Q: jobQueue.add('process_audio', { job_id, file_path })
    Q->>R: job stored in bull:job_processing (waiting)
    CT-->>C: 202 { job_id, status: "queued" }<br/>Location: /jobs/<job_id>/status

    loop client polls
        C->>CT: GET /jobs/<job_id>/status
        CT->>S: getJob(job_id)
        S->>R: HGETALL job:<job_id>
        CT-->>C: 200 { job_id, status, ... }  (unknown id → 404)
    end
```

**If Redis is down** when the job record or the queue entry is created, the API deletes the job record and the saved file, so nothing is left half-created, and returns `503 QUEUE_UNAVAILABLE`. The client can simply try again.

---

## 3. Two things in Redis: the job record and the queue

These are easy to mix up, so here they are side by side:

| | Job record | Queue entry |
|---|---|---|
| Redis key | `job:<job_id>` (a hash) | `bull:job_processing:<job_id>`, plus the `bull:job_processing:wait` list |
| Created by | `src/services/jobs.js` | `src/redis/job-queue.js` (the BullMQ library) |
| Purpose | Remembers the job's **status** for the client | **Delivers work** to a worker |
| Contents | `job_id, status, file_path, original_name, created_at, updated_at` | `{job_id, file_path}` |
| Read by | `GET /jobs/:job_id/status` | Service worker 1 (next part) |
| Lifetime | Stays after the job finishes | BullMQ removes it once the job is done |

A good analogy is a restaurant:
- The **queue** is the ticket rail in the kitchen. Tickets wait there until a cook (a worker) takes one. Once the dish is done, the ticket is thrown away.
- The **job record** is the order on the waiter's notepad. It tracks where the order is, and it's what you check when the customer asks "is my food ready?".

### Job status lifecycle
Part 1 only ever sets `queued` (not `started`), because at that point the job is only waiting in the queue and no work has started. The workers in later parts move the job forward.
Each status is in the past tense and means that step has **finished**. For example, `standardised` means the 16 kHz mono WAV already exists. While worker 1 is still converting, the status stays `queued`; worker 1 will add a `started_at` time to the record when it picks the job up.

Don't confuse the status with the queue entry's name. Every queue entry is named `process_audio`, which only describes the kind of work. The status is always read from the job record.

```mermaid
stateDiagram-v2
    [*] --> queued: upload accepted (Part 1)
    queued --> standardised: worker 1 converts to 16 kHz mono WAV
    standardised --> chunked: worker 1 splits it into chunks
    chunked --> transcribing: worker 2 sends chunks to the Transcribing Blackbox
    transcribing --> completed: chunks merged into one transcript
    queued --> failed
    standardised --> failed
    chunked --> failed
    transcribing --> failed
    completed --> [*]
    failed --> [*]
```

### How a queue entry moves through BullMQ
Inside the queue, BullMQ tracks each job with its own states. These describe *delivery*, not our business status:

```mermaid
flowchart LR
    W[waiting] -->|a worker picks it up| A[active]
    A -->|success| C[completed]
    A -->|error, attempts left| D[delayed<br/>backoff 5s, 10s] --> W
    A -->|error, 3 attempts used| F[failed]
```
In Part 1 there is no worker yet, so every job stays in **waiting**. That's expected.

---

## 4. Code map

```
transcription-pipeline/
├── docker-compose.yml                Redis + RedisInsight containers
├── package.json                      dependencies and npm scripts
├── storage/uploads/                  uploaded audio files (created automatically, not in git)
└── src/
    ├── server.js                     entry point: creates the Express app, mounts routes, starts listening
    ├── config.js                     settings: port, upload folder, max upload size, Redis URL
    ├── controllers/
    │   └── jobs.controller.js        the endpoints: POST /jobs, GET /jobs/:job_id/status
    ├── middlewares/
    │   └── error-handler.middleware.js   turns thrown errors into JSON error responses
    ├── services/
    │   └── jobs.js                   job records in Redis: createJob / getJob / deleteJob
    ├── redis/
    │   ├── redis.js                  the single shared Redis connection
    │   └── job-queue.js              the job_processing queue (BullMQ)
    └── utils/
        └── upload.js                 saveAudioFile(req, res): saves the uploaded file with multer
```

What each layer is responsible for:

| Folder | Role | Knows about HTTP? |
|---|---|---|
| `controllers/` | Handles a request from start to finish: checks it, calls the helpers in order, sends the response | yes |
| `middlewares/` | Runs around the routes; the error handler catches anything a route throws | yes |
| `services/` | Business data: reading and writing job records | no |
| `redis/` | Infrastructure: the Redis connection and the queue | no |
| `utils/` | Reusable helpers: saving an uploaded file to disk | only reads the request |

How the files import each other:

```mermaid
flowchart TD
    server[server.js] --> controller[controllers/jobs.controller.js]
    server --> errorHandler[middlewares/error-handler.middleware.js]
    server --> config[config.js]
    controller --> upload[utils/upload.js]
    controller --> service[services/jobs.js]
    controller --> queue[redis/job-queue.js]
    service --> redis[redis/redis.js]
    queue --> redis
    upload --> config
    redis --> config
```

Reading the upload endpoint top to bottom tells the whole story:

```js
jobsRouter.post('/', async (req, res) => {
  if (!req.is('multipart/form-data')) return 415;            // 1. right request type?
  const file = await saveAudioFile(req, res);                // 2. save the file (throws → 413/400/415)
  if (!file) return 400;
  const job_id = randomUUID();
  await createJob({ job_id, file_path, original_name });     // 3. job record, status "queued"
  await jobQueue.add('process_audio', { job_id, file_path });  // 4. queue it for service worker 1
  res.status(202).json({ job_id, status: 'queued' });        // 5. reply (Redis down → 503 instead)
});
```

## 5. Running it

**Requirements:** Node 20+ and Docker Desktop.

```bash
npm install
docker compose up -d     # start Redis and RedisInsight
npm run dev              # start the API on http://localhost:3000 (restarts when you edit files)
```

Upload a file. With curl, set the type, otherwise curl sends `application/octet-stream` and the API rejects it:
```bash
curl -i -F "file=@/path/to/song.mp3;type=audio/mpeg" http://localhost:3000/jobs
```
```
HTTP/1.1 202 Accepted
Location: /jobs/6c00a623-.../status
{"job_id":"6c00a623-...","status":"queued"}
```

Poll the status:
```bash
curl http://localhost:3000/jobs/6c00a623-.../status
```
```json
{"job_id":"6c00a623-...","status":"queued","original_name":"song.mp3","created_at":"...","updated_at":"..."}
```

Settings can be changed with environment variables, e.g. `PORT=4000 MAX_UPLOAD_MB=100 npm run dev`.

---

## 6. API reference

### `POST /jobs`
Send exactly one audio file as `multipart/form-data`. Any form field name works.

| Situation | Response |
|---|---|
| Accepted | **202** `{job_id, status: "queued"}` + `Location` header |
| Body isn't multipart/form-data | **415** `UNSUPPORTED_MEDIA_TYPE` |
| File isn't audio (mimetype not `audio/*`) | **415** `UNSUPPORTED_FILE_TYPE` |
| More than one file | **400** `TOO_MANY_FILES` |
| No file | **400** `FILE_REQUIRED` |
| Bigger than `MAX_UPLOAD_MB` (default 500) | **413** `FILE_TOO_LARGE` |
| Redis unavailable | **503** `QUEUE_UNAVAILABLE` |

### `GET /jobs/:job_id/status`
| Situation | Response |
|---|---|
| Job exists | **200** `{job_id, status, original_name, created_at, updated_at}` |
| Unknown id | **404** `JOB_NOT_FOUND` |

Every error has the same shape: `{"error": {"code": "...", "message": "..."}}`.

---

## 7. Looking inside Redis

After an upload, Redis contains:

| Key | Type | What it is |
|---|---|---|
| `job:<job_id>` | hash | our job record (status lives here) |
| `bull:job_processing:<job_id>` | hash | the queue entry: `name` (`process_audio`, a label for the kind of work, **not** the status), `data` (`{job_id, file_path}`), `opts` (retry settings) |
| `bull:job_processing:wait` | list | ids of jobs waiting for a worker |
| `bull:job_processing:events` | stream | history of queue events (`added`, …) |
| `bull:job_processing:meta`, `:id`, `:marker` | various | BullMQ internals; ignore these |

**Option A: RedisInsight (GUI)**
1. Open http://localhost:5540 → **Connect existing database**.
2. Host: **`redis`**, port **6379**. Use `redis`, not `localhost`: RedisInsight runs inside Docker, where Redis is reachable by its service name. The URL form is `redis://default@redis:6379`.
3. Open the database → **Browse**. Switch to tree view to see the keys grouped under `bull › job_processing` and `job`.

**Option B: redis-cli (terminal)**
```bash
docker compose exec redis redis-cli
HGETALL job:<job_id>                   # the job record
LRANGE bull:job_processing:wait 0 -1   # job ids waiting in the queue
HGETALL bull:job_processing:<job_id>   # the queue entry
MONITOR                                # live view of every command — upload a file and watch
```

### Docker settings (docker-compose.yml)
| Setting | Why |
|---|---|
| `--appendonly yes` | Redis also writes every change to disk, so queued jobs survive a restart. |
| `--maxmemory-policy noeviction` | Required by BullMQ: when memory is full, Redis returns an error instead of silently deleting keys (which could include queued jobs). |
| volume `redis-data` | Data lives in a Docker volume, so it survives `docker compose down`. Only `docker compose down -v` deletes it. |
| healthcheck | Docker Desktop shows the container as *healthy* once Redis answers `PING`. |

---

## 8. What's next

```mermaid
flowchart LR
    P1["✅ Part 1<br/>upload → job → queue → status"]
    P2["Service worker 1<br/>ffmpeg: standardise to 16 kHz mono WAV,<br/>split into chunks → chunk_processing queue"]
    P3["Service worker 2<br/>sends chunks to the Transcribing Blackbox<br/>(faster-whisper), fixes timestamps"]
    P4["Merge<br/>one transcript → status completed,<br/>/status returns text + segments"]
    P1 --> P2 --> P3 --> P4
```
