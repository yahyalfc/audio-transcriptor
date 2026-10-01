// ─────────────────────────────────────────────────────────────────────────────
// error-handler.middleware.js: turns thrown errors into JSON error responses.
//
// When anything inside a route throws (e.g. saveAudioFile rejects an upload,
// or Redis is unreachable), Express skips the rest of the route and calls this.
// Every error response has the same shape: { error: { code, message } }
// Registered last in server.js.
// ─────────────────────────────────────────────────────────────────────────────

export function errorHandler(err, req, res, next) {
  // ── Upload errors, thrown by saveAudioFile (utils/upload.js) ──

  // The file is bigger than config.maxUploadMb.
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: { code: 'FILE_TOO_LARGE', message: 'File too large' } });
  }
  // The request contained more than one file.
  if (err.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({ error: { code: 'TOO_MANY_FILES', message: 'Send only one file' } });
  }
  // The file's mimetype isn't audio/* (e.g. a PDF or a video).
  if (err.code === 'UNSUPPORTED_FILE_TYPE') {
    return res.status(415).json({ error: { code: 'UNSUPPORTED_FILE_TYPE', message: err.message } });
  }

  // ── Anything else is unexpected: a bug, or an outage such as Redis being down ──
  // Log the full error for us, but don't leak internals to the client.
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
}
