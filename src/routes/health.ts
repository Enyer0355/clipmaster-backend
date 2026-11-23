import { Router } from 'express';
import { VERSION, type Config } from '../config.js';
import { asyncHandler } from '../errors.js';
import { getBinaryStatus } from '../ffmpeg.js';

/** Public liveness check (Render health checks hit this). No auth. */
export function healthRouter(config: Config): Router {
  const router = Router();
  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const binaries = await getBinaryStatus();
      const healthy = binaries.ffmpeg && binaries.ffprobe;
      res.status(healthy ? 200 : 503).json({
        ok: healthy,
        status: healthy ? 'ok' : 'degraded',
        service: 'clipmaster-processor',
        version: VERSION,
        uptimeSeconds: Math.floor(process.uptime()),
        ffmpeg: binaries.ffmpeg,
        ffprobe: binaries.ffprobe,
        groqConfigured: Boolean(config.groqApiKey),
        authEnabled: Boolean(config.processingApiKey),
      });
    }),
  );
  return router;
}
