import { createServer } from 'node:http';
import { config } from './config.js';
import { createApp } from './app.js';
import { getBinaryStatus } from './ffmpeg.js';

async function main(): Promise<void> {
  const app = createApp(config);
  const server = createServer(app);

  const binaries = await getBinaryStatus();
  if (!binaries.ffmpeg || !binaries.ffprobe) {
    console.error(
      '[startup] WARNING: ffmpeg/ffprobe not found in PATH — processing endpoints will fail.',
    );
  } else {
    console.log('[startup] ffmpeg + ffprobe available.');
  }
  if (!config.groqApiKey) {
    console.warn('[startup] GROQ_API_KEY is not set — /api/process/transcribe will return 503.');
  }
  if (!config.processingApiKey) {
    console.warn('[startup] PROCESSING_API_KEY is not set — API endpoints are unauthenticated.');
  }

  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  console.log(`[startup] clipmaster-processor listening on port ${config.port}`);

  const shutdown = (signal: string): void => {
    console.log(`[shutdown] ${signal} received, closing server...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error('[startup] Fatal error:', err);
  process.exit(1);
});
