// Reject anything that isn't multipart/form-data before multer touches the request.
import type { NextFunction, Request, Response } from 'express';

export function requireMultipart(req: Request, res: Response, next: NextFunction) {
  if (!req.is('multipart/form-data')) {
    return res.status(415).json({
      error: {
        code: 'UNSUPPORTED_MEDIA_TYPE',
        message: 'Content-Type must be multipart/form-data',
      },
    });
  }
  next();
}
