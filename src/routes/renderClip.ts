import { writeFile } from 'node:fs/promises';
import { Router } from 'express';
import type { Config } from '../config.js';
import { ApiError, asyncHandler } from '../errors.js';
import { parseRenderClipRequest, sendFileResponse } from '../adapter.js';
import { resolveMedia, safeUnlink, tempPath } from '../media.js';
import { cropForAspectRatio, probeMedia, renderClip } from '../ffmpeg.js';
import {
  buildAss,
  fontSizeForHeight,
  groupWordsIntoSegments,
  marginVForHeight,
  shiftWordsToClip,
} from '../captions.js';
import { createMutex } from '../mutex.js';
import { createUpload, uploadFields, withUploadCleanup } from '../middleware/upload.js';

// Free tier has 0.1 CPU: render one clip at a time.
const renderMutex = createMutex();

export function renderClipRouter(config: Config): Router {
  const router = Router();
  const upload = createUpload(config);
  router.post(
    '/',
    upload.fields(uploadFields()),
    asyncHandler(
      withUploadCleanup(async (req, res) => {
        const input = parseRenderClipRequest(req, config.maxClipSeconds);
      const media = await resolveMedia(input, config);
      const outPath = tempPath('clip', '.mp4');
      let assPath: string | undefined;
      try {
        const meta = await probeMedia(media.path, config.probeTimeoutMs);
        if (input.endSeconds > meta.durationSeconds + 0.5) {
          throw ApiError.badRequest(
            `Field "end" (${input.endSeconds}s) exceeds the video duration (${meta.durationSeconds.toFixed(2)}s).`,
          );
        }
        const crop =
          input.aspectRatio !== undefined
            ? cropForAspectRatio(input.aspectRatio, meta.width, meta.height)
            : undefined;
        if (input.captions && input.captions.length > 0) {
          const clipWords = shiftWordsToClip(
            input.captions,
            input.startSeconds,
            input.endSeconds,
          );
          if (clipWords.length > 0) {
            const segments = groupWordsIntoSegments(clipWords);
            const ass = buildAss(segments, {
              fontSize: fontSizeForHeight(meta.height),
              marginV: marginVForHeight(meta.height),
            });
            assPath = tempPath('captions', '.ass');
            await writeFile(assPath, ass, 'utf8');
          }
        }
        // Cap output at 720p for speed on the free tier (the app aborts
        // renders after 55 s); an explicit width/height from the caller wins.
        const outWidth = input.width;
        const outHeight = input.height ?? (meta.height > 720 ? 720 : undefined);
        await renderMutex(() =>
          renderClip(
            media.path,
            outPath,
            {
              startSeconds: input.startSeconds,
              endSeconds: input.endSeconds,
              width: outWidth,
              height: outHeight,
              crop,
              assPath,
              hasAudio: meta.hasAudio,
            },
            config.renderTimeoutMs,
          ),
        );
        await sendFileResponse(res, outPath, 'video/mp4', 'clip.mp4', input.returnJson);
      } finally {
        await media.cleanup();
        await safeUnlink(outPath);
        await safeUnlink(assPath);
      }
      }),
    ),
  );
  return router;
}
