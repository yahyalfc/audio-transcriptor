import express from 'express';
import { jobsRouter } from './routes/jobs.js';
import { errorHandler } from './middleware/errorHandler.js';

export const app = express();

app.use('/jobs', jobsRouter);

app.use((req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `${req.method} ${req.path} not found` } });
});

app.use(errorHandler);
