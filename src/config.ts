import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  port: Number(process.env.PORT) || 3000,
  uploadDir: path.resolve(rootDir, process.env.UPLOAD_DIR || 'storage/uploads'),
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB) || 500,
};
