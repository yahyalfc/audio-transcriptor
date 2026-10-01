declare global {
  namespace Express {
    interface Request {
      /** Set by the upload middleware: the UUID the file is stored under. */
      file_id?: string;
    }
  }
}

export {};
