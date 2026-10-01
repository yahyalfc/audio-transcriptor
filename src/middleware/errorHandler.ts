import multer from 'multer';
import type { NextFunction, Request, Response } from 'express';

const multerErrors: Record<string, { status: number; code: string }> = {
  LIMIT_FILE_SIZE: { status: 413, code: 'FILE_TOO_LARGE' },
  LIMIT_FILE_COUNT: { status: 400, code: 'TOO_MANY_FILES' },
  LIMIT_UNEXPECTED_FILE: { status: 400, code: 'UNEXPECTED_FILE' },
};

export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction) {
  if (err instanceof multer.MulterError) {
    const { status, code } = multerErrors[err.code] ?? { status: 400, code: err.code };
    const message =
      err.code === 'LIMIT_UNEXPECTED_FILE'
        ? `Send exactly one file in the "file" field (got "${err.field}")`
        : err.message;
    return res.status(status).json({ error: { code, message } });
  }

  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
}
