/**
 * Server configuration, read from environment variables.
 * No secrets are ever hardcoded here — keys come from env only.
 */

export const VERSION = '1.0.0';

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface Config {
  port: number;
  nodeEnv: string;
  /** Optional shared secret for `Authorization: Bearer ...` on /api/process/*. */
  processingApiKey: string | undefined;
  /** Groq API key for Whisper transcription. Undefined = transcribe returns 503. */
  groqApiKey: string | undefined;
  groqModel: string;
  /** Groq's hard limit for a single audio upload. */
  groqAudioMaxBytes: number;
  maxUploadBytes: number;
  maxDownloadBytes: number;
  maxClipSeconds: number;
  probeTimeoutMs: number;
  thumbnailTimeoutMs: number;
  renderTimeoutMs: number;
  transcribeTimeoutMs: number;
  downloadTimeoutMs: number;
}

const MB = 1024 * 1024;

export const config: Config = {
  port: intEnv('PORT', 10000),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  processingApiKey: process.env.PROCESSING_API_KEY || undefined,
  groqApiKey: process.env.GROQ_API_KEY || undefined,
  groqModel: process.env.GROQ_MODEL ?? 'whisper-large-v3-turbo',
  groqAudioMaxBytes: 25 * MB,
  maxUploadBytes: intEnv('MAX_UPLOAD_MB', 500) * MB,
  maxDownloadBytes: intEnv('MAX_DOWNLOAD_MB', 500) * MB,
  maxClipSeconds: intEnv('MAX_CLIP_SECONDS', 300),
  probeTimeoutMs: intEnv('PROBE_TIMEOUT_MS', 60_000),
  thumbnailTimeoutMs: intEnv('THUMBNAIL_TIMEOUT_MS', 120_000),
  renderTimeoutMs: intEnv('RENDER_TIMEOUT_MS', 600_000),
  transcribeTimeoutMs: intEnv('TRANSCRIBE_TIMEOUT_MS', 300_000),
  downloadTimeoutMs: intEnv('DOWNLOAD_TIMEOUT_MS', 120_000),
};
