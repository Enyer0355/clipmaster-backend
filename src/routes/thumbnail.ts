import { Router } from 'express';
import type { Config } from '../config.js';
import { asyncHandler } from '../errors.js';
import { parseThumbnailRequest, sendFileResponse } from '../adapter.js';
import { resolveMedia, safeUnlink, tempPath } from '../media.js';
import { makeThumbnail, probeMedia } from '../ffmpeg.js';
import { createUpload, uploadFields, withUploadCleanup } from '../middleware/upload.js';

export function thumbnailRouter(config: Config): Router {
  const router = Router();
  const upload = createUpload(config);
  router.post(
    '/',
    upload.fields(uploadFields()),
    asyncHandler(
      withUploadCleanup(async (req, res) => {
        const input = parseThumbnailRequest(req);
        const media = await resolveMedia(input, config);
        const outPath = tempPath('thumbnail', input.format === 'png' ? '.png' : '.jpg');
        try {
          // Probe first so the default frame time adapts to short videos.
          const meta = await probeMedia(media.path, config.probeTimeoutMs);
          const time = input.timeSeconds ?? Math.min(1, Math.max(0, meta.durationSeconds / 10));
          await makeThumbnail(
            media.path,
            outPath,
            { timeSeconds: time, width: input.width ?? 640, height: input.height, format: input.format },
            config.thumbnailTimeoutMs,
          );
          await sendFileResponse(
            res,
            outPath,
            input.format === 'png' ? 'image/png' : 'image/jpeg',
            `thumbnail.${input.format}`,
            input.returnJson,
          );
        } finally {
          await media.cleanup();
          await safeUnlink(outPath);
        }
      }),
    ),
  );
  return router;
}
