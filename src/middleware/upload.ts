import path from 'node:path';
import { randomUUID } from 'node:crypto';
import multer from 'multer';
import { config } from '../config.js';

// Stream the upload straight to disk; never buffer the whole file in memory.
const storage = multer.diskStorage({
  destination: config.uploadDir,
  filename(req, file, cb) {
    // Never trust the client's filename as a path: keep only its extension.
    const fileId = randomUUID();
    const ext = path.extname(file.originalname).toLowerCase();
    req.file_id = fileId;
    cb(null, `${fileId}${ext}`);
  },
});

export const uploadSingleFile = multer({
  storage,
  limits: {
    files: 1,
    fileSize: config.maxUploadMb * 1024 * 1024,
  },
}).single('file');
