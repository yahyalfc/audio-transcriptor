import { Router } from 'express';
import { requireMultipart } from '../middleware/requireMultipart.js';
import { uploadSingleFile } from '../middleware/upload.js';

export const jobsRouter = Router();

jobsRouter.post('/', requireMultipart, uploadSingleFile, (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      error: { code: 'FILE_REQUIRED', message: 'Attach an audio file in the "file" field' },
    });
  }

  res.status(201).json({
    file_id: req.file_id,
    original_name: req.file.originalname,
    size_bytes: req.file.size,
    mime_type: req.file.mimetype,
    path: req.file.path,
  });
});
