/**
 * Resolves a video/audio input into a local temp file, from either:
 *   - a multipart file upload (multer disk storage), or
 *   - a remote http(s) URL, downloaded with a size cap and timeout.
 * Every resolved file comes with a cleanup() that deletes it.
 *
 * Downloads use Node's `http`/`https` directly (NOT global fetch):
 * undici's async-iterator body consumption can crash the whole process
 * with an internal assertion when the server closes the connection
 * (e.g. HTTP/1.0 servers). The http/https stream pipeline below is
 * immune to that and gives us explicit redirect + timeout control.
 */
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get as httpGet, type ClientRequest } from 'node:http';
import { get as httpsGet } from 'node:https';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { VERSION } from './config.js';
import { ApiError } from './errors.js';

export interface LocalMedia {
  path: string;
  originalName: string;
  mimeType: string;
  cleanup: () => Promise<void>;
}

export interface MediaInput {
  sourceUrl?: string;
  file?: Express.Multer.File;
}

const MAX_REDIRECTS = 5;
const SIZE_LIMIT_ERROR = 'CLIPMASTER_SIZE_LIMIT';

export function tempPath(prefix: string, ext = ''): string {
  const safeExt = ext === '' ? '' : ext.startsWith('.') ? ext : `.${ext}`;
  return join(tmpdir(), `clipmaster-${prefix}-${randomUUID()}${safeExt}`);
}

export async function safeUnlink(path: string | undefined): Promise<void> {
  if (!path) return;
  try {
    await unlink(path);
  } catch {
    // Already gone — nothing to do.
  }
}

function limitMessage(maxBytes: number): string {
  return `Source file exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`;
}

type DownloadResult = { kind: 'done' } | { kind: 'redirect'; location: string };

async function downloadAttempt(
  url: URL,
  dest: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<DownloadResult> {
  return new Promise<DownloadResult>((resolve, reject) => {
    let settled = false;
    const state: { req?: ClientRequest } = {};
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      state.req?.destroy();
      reject(ApiError.timeout(`Download timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
    timer.unref();
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const get = url.protocol === 'https:' ? httpsGet : httpGet;
    state.req = get(
      url,
      { headers: { 'User-Agent': `clipmaster-processor/${VERSION}` } },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.resume(); // drain the body so the socket can close
          settle(() => resolve({ kind: 'redirect', location }));
          return;
        }
        if (status !== 200) {
          res.resume();
          settle(() =>
            reject(ApiError.upstream(`Source URL returned HTTP ${status}.`, 'download_failed')),
          );
          return;
        }
        const contentLength = Number(res.headers['content-length']);
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
          res.resume();
          settle(() => reject(ApiError.payloadTooLarge(limitMessage(maxBytes))));
          return;
        }
        let bytes = 0;
        const counter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length;
            if (bytes > maxBytes) {
              callback(new Error(SIZE_LIMIT_ERROR));
              return;
            }
            callback(null, chunk);
          },
        });
        const writer = createWriteStream(dest);
        pipeline(res, counter, writer)
          .then(() => settle(() => resolve({ kind: 'done' })))
          .catch((err: unknown) => {
            if (err instanceof Error && err.message === SIZE_LIMIT_ERROR) {
              settle(() => reject(ApiError.payloadTooLarge(limitMessage(maxBytes))));
            } else {
              settle(() =>
                reject(
                  ApiError.upstream(
                    `Download failed: ${err instanceof Error ? err.message : String(err)}`,
                    'download_failed',
                  ),
                ),
              );
            }
          });
      },
    );
    state.req.on('error', (err) => {
      settle(() =>
        reject(
          ApiError.upstream(
            `Could not download source URL: ${err.message}`,
            'download_failed',
          ),
        ),
      );
    });
  });
}

async function downloadToTemp(
  url: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<string> {
  const dest = tempPath('download');
  try {
    let current = new URL(url);
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      const result = await downloadAttempt(current, dest, maxBytes, timeoutMs);
      if (result.kind === 'done') return dest;
      current = new URL(result.location, current);
    }
    throw ApiError.upstream(
      'Too many redirects while downloading source URL.',
      'download_failed',
    );
  } catch (err) {
    await safeUnlink(dest);
    throw err;
  }
}

export async function resolveMedia(
  input: MediaInput,
  opts: { maxDownloadBytes: number; downloadTimeoutMs: number },
): Promise<LocalMedia> {
  if (input.file) {
    const file = input.file;
    return {
      path: file.path,
      originalName: file.originalname,
      mimeType: file.mimetype,
      cleanup: () => safeUnlink(file.path),
    };
  }
  if (input.sourceUrl) {
    let parsed: URL;
    try {
      parsed = new URL(input.sourceUrl);
    } catch {
      throw ApiError.badRequest('sourceUrl is not a valid URL.');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw ApiError.badRequest('sourceUrl must use http(s).');
    }
    const path = await downloadToTemp(
      input.sourceUrl,
      opts.maxDownloadBytes,
      opts.downloadTimeoutMs,
    );
    const name = parsed.pathname.split('/').pop() || 'video';
    return {
      path,
      originalName: name,
      mimeType: 'application/octet-stream',
      cleanup: () => safeUnlink(path),
    };
  }
  throw ApiError.badRequest(
    'Provide a video file upload or a sourceUrl.',
  );
}
