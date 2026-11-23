import express, { type Express, type NextFunction, type Request, type Response, Router } from 'express';
import { VERSION, type Config } from './config.js';
import { errorHandler, notFoundHandler } from './errors.js';
import { requireBearerAuth } from './auth.js';
import { healthRouter } from './routes/health.js';
import { probeRouter } from './routes/probe.js';
import { thumbnailRouter } from './routes/thumbnail.js';
import { renderClipRouter } from './routes/renderClip.js';
import { transcribeRouter } from './routes/transcribe.js';

function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const started = Date.now();
  res.on('finish', () => {
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms`,
    );
  });
  next();
}

export function createApp(config: Config): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10mb' }));
  app.use(requestLogger);

  app.get('/', (_req, res) => {
    res.json({
      ok: true,
      service: 'clipmaster-processor',
      version: VERSION,
      endpoints: [
        'GET /health',
        'POST /api/process/probe',
        'POST /api/process/thumbnail',
        'POST /api/process/render-clip',
        'POST /api/process/transcribe',
      ],
    });
  });

  // Public: Render health checks must reach this without auth.
  app.use('/health', healthRouter(config));

  const api = Router();
  api.use(requireBearerAuth(config.processingApiKey));
  api.use('/process/probe', probeRouter(config));
  api.use('/process/thumbnail', thumbnailRouter(config));
  api.use('/process/render-clip', renderClipRouter(config));
  api.use('/process/transcribe', transcribeRouter(config));
  app.use('/api', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
