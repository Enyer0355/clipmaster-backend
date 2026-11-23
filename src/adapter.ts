/**
 * =====================================================================
 * CONTRACT ADAPTER — the single place where the ClipMaster AI app's
 * request/response shapes are mapped to this backend's internal types.
 *
 * The exact JSON contract was verified against the app's
 * `server/media.ts` (2026-11-23), including render-clip (fields
 * video/clipId/startSec/endSec/aspectRatio/burnSubtitles/captionsJson,
 * 55 s timeout, MP4 bytes back). This module:
 *   - accepts flexible aliases for every field
 *     (e.g. `sourceUrl` | `url` | `videoUrl`, `start` | `startTime`),
 *   - accepts video input as a multipart file OR a source URL,
 *   - returns a clean, documented JSON shape (see README).
 *
 * When the real contract is known, adjust ONLY this file — the routes,
 * the ffmpeg wrapper, the captions builder and the Groq client stay
 * untouched.
 * =====================================================================
 */
import { readFile } from 'node:fs/promises';
import type { Request, Response } from 'express';
import { ApiError } from './errors.js';
import { collectUploadedFiles } from './middleware/upload.js';
import type { CaptionSegment, CaptionWord } from './captions.js';
import type { VideoMetadata } from './ffmpeg.js';
import type { GroqTranscription } from './groq.js';

export type UploadedFile = Express.Multer.File;

export interface ProbeInput {
  sourceUrl?: string;
  file?: UploadedFile;
}

export interface ThumbnailInput extends ProbeInput {
  timeSeconds?: number;
  width?: number;
  height?: number;
  format: 'jpg' | 'png';
  returnJson: boolean;
}

export interface RenderClipInput extends ProbeInput {
  startSeconds: number;
  endSeconds: number;
  width?: number;
  height?: number;
  /** e.g. '9:16' | '16:9' | '1:1' (ClipMaster AI ClipAspectRatio). */
  aspectRatio?: string;
  /** When false, captions are ignored even if provided. Default true. */
  burnSubtitles: boolean;
  /** Words in SOURCE-video absolute timestamps (Whisper's clock). */
  captions?: CaptionWord[];
  returnJson: boolean;
}

export interface TranscribeInput extends ProbeInput {
  language?: string;
}

/** Pick the uploaded file out of a multipart request (any field name). */
export function uploadedFile(req: Request): UploadedFile | undefined {
  return collectUploadedFiles(req)[0];
}

function bodyOf(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {};
}

function queryString(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function firstString(body: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function parseNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) {
    throw ApiError.badRequest(`Field "${field}" must be a number.`);
  }
  return num;
}

function parseOptionalInt(value: unknown, field: string): number | undefined {
  const num = parseNumber(value, field);
  if (num === undefined) return undefined;
  return Math.round(num);
}

function parsePositiveInt(value: unknown, field: string): number | undefined {
  const num = parseOptionalInt(value, field);
  if (num !== undefined && num <= 0) {
    throw ApiError.badRequest(`Field "${field}" must be > 0.`);
  }
  return num;
}

function parseSourceUrl(req: Request): string | undefined {
  const body = bodyOf(req);
  return (
    firstString(body, ['sourceUrl', 'source_url', 'url', 'videoUrl', 'video_url']) ??
    queryString(req, 'sourceUrl') ??
    queryString(req, 'url')
  );
}

/** Binary endpoints return the file by default; JSON (base64) on request. */
function parseReturnJson(req: Request): boolean {
  const body = bodyOf(req);
  if (body.returnJson === true || body.returnJson === 'true') return true;
  if (queryString(req, 'format') === 'json') return true;
  return false;
}

function parseCaptionWord(item: unknown): CaptionWord {
  if (!item || typeof item !== 'object') {
    throw ApiError.badRequest('Each caption word must be an object with word/start/end.');
  }
  const obj = item as Record<string, unknown>;
  const word =
    typeof obj.word === 'string' ? obj.word : typeof obj.text === 'string' ? obj.text : undefined;
  if (!word || !word.trim()) {
    throw ApiError.badRequest('Each caption word needs a non-empty "word" (or "text").');
  }
  const start = parseNumber(obj.start, 'captions[].start');
  const end = parseNumber(obj.end, 'captions[].end');
  if (start === undefined || end === undefined) {
    throw ApiError.badRequest('Each caption word needs numeric "start" and "end" (seconds).');
  }
  if (end <= start) {
    throw ApiError.badRequest('Caption word "end" must be greater than "start".');
  }
  return { word: word.trim(), start, end };
}

/**
 * Accepts captions as:
 *   - words:      [{ word, start, end }, ...]
 *   - segments:   [{ text, start, end, words: [...] }, ...]
 *   - app segments (ClipMaster AI server/media.ts): [{ text, startOffsetSec, endOffsetSec }]
 *     — offsets are RELATIVE to the clip start; baseOffsetSeconds (the clip's
 *     startSec) is added to convert them to source-video absolute time.
 * Also accepts a JSON string (multipart form fields arrive as strings).
 */
export function parseCaptions(value: unknown, baseOffsetSeconds = 0): CaptionWord[] | undefined {
  if (value === undefined || value === null) return undefined;
  let parsed: unknown = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      throw ApiError.badRequest('Field "captions" must be a JSON array.');
    }
  }
  if (!Array.isArray(parsed)) {
    throw ApiError.badRequest('Field "captions" must be an array of words or segments.');
  }
  const words: CaptionWord[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') {
      throw ApiError.badRequest('Each caption must be an object with word/start/end.');
    }
    const obj = item as Record<string, unknown>;
    if (Array.isArray(obj.words)) {
      for (const w of obj.words) words.push(parseCaptionWord(w));
      continue;
    }
    if (
      typeof obj.text === 'string' &&
      obj.startOffsetSec !== undefined &&
      obj.endOffsetSec !== undefined &&
      obj.word === undefined
    ) {
      // ClipMaster AI CaptionSegment: offsets relative to the clip start.
      const start =
        (parseNumber(obj.startOffsetSec, 'captions[].startOffsetSec') as number) +
        baseOffsetSeconds;
      const end =
        (parseNumber(obj.endOffsetSec, 'captions[].endOffsetSec') as number) +
        baseOffsetSeconds;
      if (end <= start) {
        throw ApiError.badRequest('Caption segment "end" must be greater than "start".');
      }
      const tokens = obj.text.split(/\s+/).filter(Boolean);
      if (tokens.length === 0) continue;
      const perWord = (end - start) / tokens.length;
      tokens.forEach((token, i) => {
        words.push({ word: token, start: start + i * perWord, end: start + (i + 1) * perWord });
      });
      continue;
    }
    if (
      typeof obj.text === 'string' &&
      obj.start !== undefined &&
      obj.end !== undefined &&
      obj.word === undefined
    ) {
      const start = parseNumber(obj.start, 'captions[].start') as number;
      const end = parseNumber(obj.end, 'captions[].end') as number;
      if (end <= start) {
        throw ApiError.badRequest('Caption segment "end" must be greater than "start".');
      }
      const tokens = obj.text.split(/\s+/).filter(Boolean);
      if (tokens.length === 0) continue;
      const perWord = (end - start) / tokens.length;
      tokens.forEach((token, i) => {
        words.push({ word: token, start: start + i * perWord, end: start + (i + 1) * perWord });
      });
      continue;
    }
    words.push(parseCaptionWord(obj));
  }
  words.sort((a, b) => a.start - b.start);
  return words.length > 0 ? words : undefined;
}

export function parseProbeRequest(req: Request): ProbeInput {
  return { sourceUrl: parseSourceUrl(req), file: uploadedFile(req) };
}

export function parseThumbnailRequest(req: Request): ThumbnailInput {
  const body = bodyOf(req);
  const formatRaw = firstString(body, ['format']) ?? queryString(req, 'format');
  const format = formatRaw === 'png' ? 'png' : 'jpg';
  const timeSeconds = parseNumber(
    body.timestampSec ??
      body.timestampSeconds ??
      body.time ??
      body.timestamp ??
      body.at ??
      queryString(req, 'time'),
    'time',
  );
  if (timeSeconds !== undefined && timeSeconds < 0) {
    throw ApiError.badRequest('Field "time" must be >= 0.');
  }
  const width = parsePositiveInt(body.width ?? queryString(req, 'width'), 'width');
  const height = parsePositiveInt(body.height ?? queryString(req, 'height'), 'height');
  return {
    sourceUrl: parseSourceUrl(req),
    file: uploadedFile(req),
    timeSeconds,
    width,
    height,
    format,
    returnJson: parseReturnJson(req),
  };
}

export function parseRenderClipRequest(req: Request, maxClipSeconds: number): RenderClipInput {
  const body = bodyOf(req);
  const start = parseNumber(
    body.startSec ??
      body.start ??
      body.startTime ??
      body.startSeconds ??
      body.start_seconds,
    'start',
  );
  const end = parseNumber(
    body.endSec ?? body.end ?? body.endTime ?? body.endSeconds ?? body.end_seconds,
    'end',
  );
  if (start === undefined) throw ApiError.badRequest('Field "start" (seconds) is required.');
  if (end === undefined) throw ApiError.badRequest('Field "end" (seconds) is required.');
  if (start < 0) throw ApiError.badRequest('Field "start" must be >= 0.');
  if (end <= start) throw ApiError.badRequest('Field "end" must be greater than "start".');
  if (end - start > maxClipSeconds) {
    throw ApiError.badRequest(`Clip length exceeds the ${maxClipSeconds}s maximum.`);
  }
  const width = parsePositiveInt(body.width, 'width');
  const height = parsePositiveInt(body.height, 'height');
  const aspectRatio = firstString(body, ['aspectRatio', 'aspect_ratio']);
  const burnRaw = body.burnSubtitles ?? body.burn_subtitles;
  const burnSubtitles =
    burnRaw === undefined
      ? true
      : burnRaw === true || burnRaw === 'true' || burnRaw === '1' || burnRaw === 1;
  const captions = burnSubtitles
    ? parseCaptions(
        body.captionsJson ?? body.captions ?? body.subtitles ?? body.words,
        start,
      )
    : undefined;
  return {
    sourceUrl: parseSourceUrl(req),
    file: uploadedFile(req),
    startSeconds: start,
    endSeconds: end,
    width,
    height,
    aspectRatio,
    burnSubtitles,
    captions,
    returnJson: parseReturnJson(req),
  };
}

export function parseTranscribeRequest(req: Request): TranscribeInput {
  const body = bodyOf(req);
  const language = firstString(body, ['language', 'lang']);
  return { sourceUrl: parseSourceUrl(req), file: uploadedFile(req), language };
}

// ---- Response shapes -------------------------------------------------

export function probeResponseBody(meta: VideoMetadata): Record<string, unknown> {
  return {
    ok: true,
    durationSec: meta.durationSeconds,
    durationSeconds: meta.durationSeconds,
    width: meta.width,
    height: meta.height,
    fps: meta.fps,
    videoCodec: meta.videoCodec,
    audioCodec: meta.audioCodec,
    hasAudio: meta.hasAudio,
    bitrateKbps: meta.bitrateKbps,
    format: meta.formatName,
    sizeBytes: meta.sizeBytes,
  };
}

export function transcribeResponseBody(
  result: GroqTranscription,
  segments: CaptionSegment[],
): Record<string, unknown> {
  return {
    ok: true,
    text: result.text,
    language: result.language,
    durationSeconds: result.durationSeconds,
    words: result.words,
    segments: segments.map((s) => ({
      text: s.text,
      start: s.start,
      end: s.end,
      words: s.words,
    })),
  };
}

/**
 * Send a generated file: binary download by default, or
 * `{ ok, mimeType, filename, dataBase64 }` JSON when requested.
 */
export async function sendFileResponse(
  res: Response,
  filePath: string,
  mimeType: string,
  filename: string,
  asJson: boolean,
): Promise<void> {
  if (asJson) {
    const buffer = await readFile(filePath);
    res.json({ ok: true, mimeType, filename, dataBase64: buffer.toString('base64') });
    return;
  }
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  await new Promise<void>((resolve, reject) => {
    res.sendFile(filePath, (err) => (err ? reject(err) : resolve()));
  });
}
