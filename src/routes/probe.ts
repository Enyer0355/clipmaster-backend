import { Router } from 'express';
import type { Config } from '../config.js';
import { asyncHandler } from '../errors.js';
import { parseProbeRequest, probeResponseBody } from '../adapter.js';
import { resolveMedia } from '../media.js';
import { probeMedia } from '../ffmpeg.js';
import { createUpload, uploadFields, withUploadCleanup } from '../middleware/upload.js';

export function probeRouter(config: Config): Router {
  const router = Router();
  const upload = createUpload(config);
  router.post(
    '/',
    upload.fields(uploadFields()),
    asyncHandler(
      withUploadCleanup(async (req, res) => {
        const input = parseProbeRequest(req);
        const media = await resolveMedia(input, config);
        try {
          const meta = await probeMedia(media.path, config.probeTimeoutMs);
          res.json(probeResponseBody(meta));
        } finally {
          await media.cleanup();
        }
      }),
    ),
  );
  return router;
}
