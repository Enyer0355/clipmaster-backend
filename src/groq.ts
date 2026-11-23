/**
 * Groq Whisper transcription client (OpenAI-compatible endpoint).
 * Model: whisper-large-v3-turbo, verbose_json + word-level timestamps.
 * Free tier — key from env GROQ_API_KEY, never hardcoded.
 */
import { readFile } from 'node:fs/promises';
import { ApiError } from './errors.js';

export interface GroqWord {
  word: string;
  start: number;
  end: number;
}

export interface GroqTranscription {
  text: string;
  language: string | null;
  durationSeconds: number | null;
  words: GroqWord[];
}

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

interface GroqVerboseResponse {
  text?: string;
  language?: string;
  duration?: number;
  words?: Array<{ word?: string; start?: number; end?: number }>;
}

export async function transcribeWithGroq(
  audioPath: string,
  opts: { apiKey: string; model: string; language?: string; timeoutMs: number },
): Promise<GroqTranscription> {
  const audio = await readFile(audioPath);
  const form = new FormData();
  form.append('file', new File([audio], 'audio.mp3', { type: 'audio/mpeg' }));
  form.append('model', opts.model);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  if (opts.language) form.append('language', opts.language);

  let response: Response;
  try {
    response = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw ApiError.timeout('Groq transcription timed out.');
    }
    throw ApiError.upstream(
      `Could not reach Groq: ${err instanceof Error ? err.message : String(err)}`,
      'transcription_failed',
    );
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    let detail = bodyText.slice(0, 300);
    try {
      const parsed = JSON.parse(bodyText) as { error?: { message?: string } };
      if (parsed.error?.message) detail = parsed.error.message;
    } catch {
      // Keep the raw body text.
    }
    throw ApiError.upstream(
      `Groq transcription failed (HTTP ${response.status}): ${detail}`,
      'transcription_failed',
    );
  }

  const data = (await response.json()) as GroqVerboseResponse;
  const text = (data.text ?? '').trim();
  const duration = typeof data.duration === 'number' ? data.duration : null;
  let words: GroqWord[] = (data.words ?? [])
    .filter(
      (w): w is { word: string; start: number; end: number } =>
        typeof w.word === 'string' &&
        typeof w.start === 'number' &&
        typeof w.end === 'number',
    )
    .map((w) => ({ word: w.word.trim(), start: w.start, end: w.end }))
    .filter((w) => w.word.length > 0);

  // Fallback: if the model returned no word timestamps, spread the words
  // evenly across the duration instead of failing the whole request.
  if (words.length === 0 && text && duration && duration > 0) {
    const tokens = text.split(/\s+/).filter(Boolean);
    const perWord = duration / tokens.length;
    words = tokens.map((word, i) => ({
      word,
      start: i * perWord,
      end: (i + 1) * perWord,
    }));
  }

  return { text, language: data.language ?? null, durationSeconds: duration, words };
}
