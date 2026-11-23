/**
 * Multer setup: video/audio uploads straight to disk (temp dir),
 * with a size limit and a file-type filter. Files are deleted by
 * the route handlers after processing (see media.ts cleanup()).
 */
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { extname } from 'node:path';
import multer from 'multer';
import type { Request } from 'express';
import type { Config } from '../config.js';
import { ApiError, type AsyncHandler } from '../errors.js';
import { safeUnlink } from '../media.js';

const ACCEPTED_EXTENSIONS = new Set([
  '.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v',
  '.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac',
]);

export const UPLOAD_FIELD_NAMES = ['video', 'file', 'media', 'audio'] as const;

export function createUpload(config: Config): multer.Multer {
  const storage = multer.diskStorage({
    destination: tmpdir(),
    filename: (_req, file, cb) => {
      cb(null, `clipmaster-upload-${randomUUID()}${extname(file.originalname).toLowerCase()}`);
    },
  });
  return multer({
    storage,
    limits: { fileSize: config.maxUploadBytes, files: 1 },
    fileFilter: (_req, file, cb) => {
      const mimeOk =
        file.mimetype.startsWith('video/') || file.mimetype.startsWith('audio/');
      const extOk = ACCEPTED_EXTENSIONS.has(extname(file.originalname).toLowerCase());
      if (mimeOk || extOk) return cb(null, true);
      cb(
        ApiError.unsupportedMedia(
          `Unsupported file type: ${file.mimetype || file.originalname}. Send a video or audio file.`,
        ),
      );
    },
  });
}

/** `upload.fields(...)` argument accepting any of the known field names. */
export function uploadFields(): multer.Field[] {
  return UPLOAD_FIELD_NAMES.map((name) => ({ name, maxCount: 1 }));
}

/** All files multer saved for this request, in field-priority order. */
export function collectUploadedFiles(req: Request): Express.Multer.File[] {
  const files = req.files as
    | Record<string, Express.Multer.File[]>
    | Express.Multer.File[]
    | undefined;
  if (!files) return [];
  if (Array.isArray(files)) return files;
  const out: Express.Multer.File[] = [];
  for (const field of UPLOAD_FIELD_NAMES) {
    const list = files[field];
    if (list) out.push(...list);
  }
  return out;
}

/**
 * Deletes any multer temp files when the handler finishes — including
 * when request validation throws BEFORE the file is resolved into media
 * (otherwise those uploads leak on disk). Safe to combine with the
 * routes' own media.cleanup(): deleting twice is a no-op.
 */
export function withUploadCleanup(fn: AsyncHandler): AsyncHandler {
  return async (req, res, next) => {
    try {
      await fn(req, res, next);
    } finally {
      for (const file of collectUploadedFiles(req)) {
        await safeUnlink(file.path);
      }
    }
  };
}
