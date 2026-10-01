// ─────────────────────────────────────────────────────────────────────────────
// server.js: entry point of the API.
//
// Creates the Express app, plugs in the routes and the error handler,
// and starts listening for HTTP requests.
// Run with `npm run dev` (restarts on file changes) or `npm start`.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import express from 'express';
import { config } from './config.js';
import { jobsRouter } from './controllers/jobs.controller.js';
import { errorHandler } from './middlewares/error-handler.middleware.js';

// Create the upload folder (storage/uploads) if it doesn't exist yet,
// otherwise saving the first uploaded file would fail.
fs.mkdirSync(config.uploadDir, { recursive: true });

const app = express();

// Every /jobs/... request is handled by the jobs controller:
//   POST /jobs  and  GET /jobs/:job_id/status
app.use('/jobs', jobsRouter);

// No route matched → 404, in the same JSON error format as every other error.
app.use((req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `${req.method} ${req.path} not found` } });
});

// Registered last on purpose: Express sends any error thrown in the routes above here.
app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port}`);
});
