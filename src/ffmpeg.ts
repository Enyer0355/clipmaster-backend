/**
 * Thin wrapper around the system `ffmpeg` / `ffprobe` binaries
 * (installed in the Docker image — NOT ffmpeg-static).
 * Every call is spawned with a timeout and returns structured errors.
 */
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { ApiError } from './errors.js';

export interface VideoMetadata {
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string | null;
  audioCodec: string | null;
  hasAudio: boolean;
  bitrateKbps: number | null;
  formatName: string;
  sizeBytes: number;
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

async function runBinary(
  binary: string,
  args: string[],
  timeoutMs: number,
  label: string,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(ApiError.timeout(`${label} timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
    timer.unref();
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < 1_000_000) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        ApiError.unavailable(
          `${label} could not start ${binary}: ${err.message}`,
          'ffmpeg_unavailable',
        ),
      );
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

function parseFps(value: string | undefined): number {
  if (!value) return 0;
  const [num, den] = value.split('/').map(Number);
  if (!den) return 0;
  const fps = num / den;
  return Number.isFinite(fps) ? fps : 0;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
}

interface FfprobeOutput {
  format?: {
    duration?: string;
    bit_rate?: string;
    format_name?: string;
  };
  streams?: FfprobeStream[];
}

export async function probeMedia(
  filePath: string,
  timeoutMs: number,
): Promise<VideoMetadata> {
  const { stdout, stderr, code } = await runBinary(
    'ffprobe',
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    timeoutMs,
    'ffprobe',
  );
  if (code !== 0) {
    throw ApiError.upstream(
      `ffprobe failed: ${stderr.trim().slice(-500) || 'unknown error'}`,
      'probe_failed',
    );
  }
  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(stdout) as FfprobeOutput;
  } catch {
    throw ApiError.upstream('ffprobe returned invalid JSON.', 'probe_failed');
  }
  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  const duration = Number(parsed.format?.duration ?? video?.duration ?? 0);
  const { size } = await stat(filePath);
  return {
    durationSeconds: Number.isFinite(duration) ? duration : 0,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps: parseFps(video?.avg_frame_rate) || parseFps(video?.r_frame_rate),
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    hasAudio: Boolean(audio),
    bitrateKbps: parsed.format?.bit_rate
      ? Math.round(Number(parsed.format.bit_rate) / 1000)
      : null,
    formatName: parsed.format?.format_name ?? 'unknown',
    sizeBytes: size,
  };
}

export interface ThumbnailOptions {
  timeSeconds?: number;
  width?: number;
  height?: number;
  format?: 'jpg' | 'png';
}

export async function makeThumbnail(
  inputPath: string,
  outputPath: string,
  opts: ThumbnailOptions,
  timeoutMs: number,
): Promise<void> {
  const time = opts.timeSeconds ?? 1;
  const args = ['-ss', String(time), '-i', inputPath, '-frames:v', '1'];
  if (opts.width || opts.height) {
    args.push('-vf', `scale=${opts.width ?? -2}:${opts.height ?? -2}`);
  }
  if (opts.format !== 'png') args.push('-q:v', '3');
  args.push('-y', outputPath);
  const { stderr, code } = await runBinary('ffmpeg', args, timeoutMs, 'ffmpeg thumbnail');
  if (code !== 0) {
    throw ApiError.upstream(
      `Thumbnail generation failed: ${stderr.trim().slice(-500) || 'unknown error'}`,
      'thumbnail_failed',
    );
  }
}

export interface RenderOptions {
  startSeconds: number;
  endSeconds: number;
  width?: number;
  height?: number;
  /** Center-crop before scaling (for aspectRatio requests like 9:16). */
  crop?: { width: number; height: number };
  /** Path to an .ass subtitle file to burn in (word-by-word karaoke). */
  assPath?: string;
  /** Set false when the source has no audio stream (else ffmpeg errors). */
  hasAudio?: boolean;
}

/** Center-crop dimensions for a target aspect ratio (e.g. '9:16'), or undefined when no crop is needed. Dimensions are rounded to even numbers (required by libx264). */
export function cropForAspectRatio(
  ratio: string,
  width: number,
  height: number,
): { width: number; height: number } | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)\s*$/.exec(ratio);
  if (!match || width <= 0 || height <= 0) return undefined;
  const target = Number(match[1]) / Number(match[2]);
  if (!Number.isFinite(target) || target <= 0) return undefined;
  const current = width / height;
  if (Math.abs(current - target) / target < 0.01) return undefined;
  const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);
  if (target < current) {
    return { width: even(height * target), height };
  }
  return { width, height: even(width / target) };
}

/** Escape a file path for use inside an ffmpeg filter argument. */
function escapeFilterPath(path: string): string {
  return `'${path.replace(/\\/g, '\\\\').replace(/'/g, "'\\''").replace(/:/g, '\\:')}'`;
}

export async function renderClip(
  inputPath: string,
  outputPath: string,
  opts: RenderOptions,
  timeoutMs: number,
): Promise<void> {
  const duration = opts.endSeconds - opts.startSeconds;
  const args = [
    '-ss', String(opts.startSeconds),
    '-i', inputPath,
    '-t', String(duration),
  ];
  const filters: string[] = [];
  if (opts.crop) {
    filters.push(`crop=${opts.crop.width}:${opts.crop.height}`);
  }
  if (opts.width || opts.height) {
    filters.push(`scale=${opts.width ?? -2}:${opts.height ?? -2}`);
  }
  if (opts.assPath) {
    filters.push(`ass=${escapeFilterPath(opts.assPath)}`);
  }
  filters.push('format=yuv420p');
  args.push(
    '-vf', filters.join(','),
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '23',
  );
  if (opts.hasAudio !== false) {
    args.push('-c:a', 'aac', '-b:a', '128k');
  }
  args.push('-movflags', '+faststart', '-y', outputPath);
  const { stderr, code } = await runBinary('ffmpeg', args, timeoutMs, 'ffmpeg render');
  if (code !== 0) {
    throw ApiError.upstream(
      `Clip render failed: ${stderr.trim().slice(-500) || 'unknown error'}`,
      'render_failed',
    );
  }
}

/**
 * Extract a small mono MP3 for transcription (16 kHz, 32 kbps — plenty
 * for Whisper, ~14 MB per hour, stays under Groq's 25 MB limit for
 * most videos). Returns the extracted file size in bytes.
 */
export async function extractAudio(
  inputPath: string,
  outputPath: string,
  timeoutMs: number,
): Promise<number> {
  const args = [
    '-i', inputPath,
    '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k',
    '-y', outputPath,
  ];
  const { stderr, code } = await runBinary('ffmpeg', args, timeoutMs, 'ffmpeg audio extraction');
  if (code !== 0) {
    throw ApiError.upstream(
      `Audio extraction failed: ${stderr.trim().slice(-500) || 'unknown error'}`,
      'audio_extraction_failed',
    );
  }
  const { size } = await stat(outputPath);
  return size;
}

let binaryStatusCache: { ffmpeg: boolean; ffprobe: boolean } | null = null;

/** Check once (and cache) whether ffmpeg/ffprobe exist in PATH. */
export async function getBinaryStatus(): Promise<{ ffmpeg: boolean; ffprobe: boolean }> {
  if (binaryStatusCache) return binaryStatusCache;
  const [ffmpeg, ffprobe] = await Promise.all([
    runBinary('ffmpeg', ['-version'], 10_000, 'ffmpeg check')
      .then((r) => r.code === 0)
      .catch(() => false),
    runBinary('ffprobe', ['-version'], 10_000, 'ffprobe check')
      .then((r) => r.code === 0)
      .catch(() => false),
  ]);
  binaryStatusCache = { ffmpeg, ffprobe };
  return binaryStatusCache;
}
