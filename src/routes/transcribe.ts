import { Router } from 'express';
import type { Config } from '../config.js';
import { ApiError, asyncHandler } from '../errors.js';
import { parseTranscribeRequest, transcribeResponseBody } from '../adapter.js';
import { resolveMedia, safeUnlink, tempPath } from '../media.js';
import { extractAudio, probeMedia } from '../ffmpeg.js';
import { transcribeWithGroq } from '../groq.js';
import { groupWordsIntoSegments } from '../captions.js';
import { createUpload, uploadFields, withUploadCleanup } from '../middleware/upload.js';

export function transcribeRouter(config: Config): Router {
  const router = Router();
  const upload = createUpload(config);
  router.post(
    '/',
    upload.fields(uploadFields()),
    asyncHandler(
      withUploadCleanup(async (req, res) => {
        const input = parseTranscribeRequest(req);
      if (!config.groqApiKey) {
        throw ApiError.unavailable(
          'Transcription is not configured: set GROQ_API_KEY on the server.',
          'transcription_not_configured',
        );
      }
      const media = await resolveMedia(input, config);
      const audioPath = tempPath('audio', '.mp3');
      try {
        const meta = await probeMedia(media.path, config.probeTimeoutMs);
        if (!meta.hasAudio) {
          throw ApiError.badRequest('The video has no audio track to transcribe.');
        }
        const audioBytes = await extractAudio(
          media.path,
          audioPath,
          config.transcribeTimeoutMs,
        );
        if (audioBytes > config.groqAudioMaxBytes) {
          throw ApiError.payloadTooLarge(
            `Extracted audio (${(audioBytes / 1024 / 1024).toFixed(1)} MB) exceeds Groq's 25 MB limit. Use a shorter video.`,
          );
        }
        const result = await transcribeWithGroq(audioPath, {
          apiKey: config.groqApiKey,
          model: config.groqModel,
          language: input.language,
          timeoutMs: config.transcribeTimeoutMs,
        });
        const segments = groupWordsIntoSegments(result.words);
        res.json(transcribeResponseBody(result, segments));
      } finally {
        await media.cleanup();
        await safeUnlink(audioPath);
      }
      }),
    ),
  );
  return router;
}
