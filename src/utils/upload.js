// ─────────────────────────────────────────────────────────────────────────────
// utils/upload.js: saves the audio file from an upload request to disk.
//
// Usage inside an endpoint:
//   const file = await saveAudioFile(req, res);
//   file.path          → where it was saved, e.g. "storage/uploads/1776332d-....mp3"
//   file.originalname  → the client's own filename, e.g. "song.mp3"
//   file === undefined → the request had no file in it
//
// Throws when the upload is invalid. The error handler middleware turns those errors
// into responses: too big → 413, more than one file → 400, not audio → 415.
// When it throws, multer has already deleted anything it partly wrote.
// ─────────────────────────────────────────────────────────────────────────────

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import multer from 'multer';
import { config } from '../config.js';

// Where and under what name multer saves the file.
// multer streams the file to disk piece by piece, so even a file of several
// hundred MB never has to fit in memory.
const storage = multer.diskStorage({
  destination: config.uploadDir,

  // Save the file under a random name, keeping only the extension: "1776332d-....mp3".
  // We never use the client's own filename, so two "audio.mp3" uploads can't overwrite
  // each other, and a malicious name like "../../etc/passwd" can't escape the folder.
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${randomUUID()}${ext}`);
  },
});

// The multer instance: storage settings + which files to accept + size/count limits.
const upload = multer({
  storage,

  // Runs before the file is saved: only let audio files through
  // ("audio/mpeg", "audio/wav", ...). Anything else is rejected with UNSUPPORTED_FILE_TYPE.
  fileFilter(req, file, cb) {
    if (!file.mimetype.startsWith('audio/')) {
      const err = new Error(`Only audio files are accepted (got "${file.mimetype}")`);
      err.code = 'UNSUPPORTED_FILE_TYPE';
      return cb(err);
    }
    cb(null, true);
  },

  limits: {
    files: 1, // a second file → multer throws LIMIT_FILE_COUNT
    fileSize: config.maxUploadMb * 1024 * 1024, // too big → multer throws LIMIT_FILE_SIZE
  },
}).any(); // accept the file under any form field name; `files: 1` still caps it at one

// multer only works with callbacks: upload(req, res, callback).
// Wrapping it in a Promise lets the endpoint simply `await saveAudioFile(req, res)`.
export function saveAudioFile(req, res) {
  return new Promise((resolve, reject) => {
    upload(req, res, (err) => {
      if (err) return reject(err);
      resolve(req.files[0]); // the saved file, or undefined if none was sent
    });
  });
}
