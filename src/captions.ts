/**
 * Caption segments + ASS subtitle generation.
 *
 * Words (from Groq Whisper or the caller) are grouped into short
 * segments of 3–5 words, and rendered as an ASS file with karaoke
 * timing ({\k}) so ffmpeg burns them word-by-word: the current word
 * lights up in the highlight colour while upcoming words stay white.
 * This is the viral "animated captions" style (Submagic/CapCut-like).
 */

export interface CaptionWord {
  word: string;
  start: number; // seconds
  end: number; // seconds
}

export interface CaptionSegment {
  text: string;
  start: number;
  end: number;
  words: CaptionWord[];
}

export interface CaptionStyle {
  fontName?: string;
  fontSize?: number;
  /** ASS colour &HAABBGGRR for the currently-spoken word. Default: yellow. */
  highlightColor?: string;
  /** ASS colour &HAABBGGRR for upcoming words. Default: white. */
  baseColor?: string;
  marginV?: number;
}

export function groupWordsIntoSegments(
  words: CaptionWord[],
  opts: { minWords?: number; maxWords?: number; maxGapSeconds?: number } = {},
): CaptionSegment[] {
  const minWords = opts.minWords ?? 3;
  const maxWords = opts.maxWords ?? 5;
  const maxGap = opts.maxGapSeconds ?? 0.9;
  const segments: CaptionSegment[] = [];
  let current: CaptionWord[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    segments.push({
      text: current.map((w) => w.word).join(' '),
      start: current[0].start,
      end: current[current.length - 1].end,
      words: current,
    });
    current = [];
  };
  for (const word of words) {
    if (current.length > 0) {
      const prev = current[current.length - 1];
      const gap = word.start - prev.end;
      const prevEndsSentence = /[.!?…]$/.test(prev.word);
      if (
        gap > maxGap ||
        (prevEndsSentence && current.length >= minWords) ||
        current.length >= maxWords
      ) {
        flush();
      }
    }
    current.push(word);
  }
  flush();
  // Avoid a lonely 1-word tail: fold it into the previous segment.
  if (segments.length >= 2) {
    const last = segments[segments.length - 1];
    const prev = segments[segments.length - 2];
    if (last.words.length === 1 && prev.words.length < maxWords) {
      prev.words.push(...last.words);
      prev.text = prev.words.map((w) => w.word).join(' ');
      prev.end = last.end;
      segments.pop();
    }
  }
  return segments;
}

/**
 * Keep only the words that overlap a clip window [start, end) and
 * rebase their timestamps to clip-relative time (clip start = 0).
 * Captions are assumed to use source-video absolute timestamps
 * (the same clock Whisper returns).
 */
export function shiftWordsToClip(
  words: CaptionWord[],
  start: number,
  end: number,
): CaptionWord[] {
  return words
    .filter((w) => w.end > start && w.start < end)
    .map((w) => ({
      word: w.word,
      start: Math.max(0, w.start - start),
      end: Math.min(end - start, w.end - start),
    }));
}

function formatAssTime(seconds: number): string {
  const totalCs = Math.max(0, Math.round(seconds * 100));
  const cs = totalCs % 100;
  const totalSeconds = Math.floor(totalCs / 100);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function escapeAssText(text: string): string {
  return text.replace(/[{}]/g, '').replace(/\r?\n/g, ' ');
}

export function buildAss(
  segments: CaptionSegment[],
  style: CaptionStyle = {},
): string {
  const fontName = style.fontName ?? 'DejaVu Sans';
  const fontSize = style.fontSize ?? 48;
  const primary = style.highlightColor ?? '&H0000FFFF'; // yellow
  const secondary = style.baseColor ?? '&H00FFFFFF'; // white
  const marginV = style.marginV ?? 60;
  const lines: string[] = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1280',
    'PlayResY: 720',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${fontName},${fontSize},${primary},${secondary},&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,0,2,10,10,${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  for (const segment of segments) {
    const text = segment.words
      .map((w) => {
        const durCs = Math.max(1, Math.round((w.end - w.start) * 100));
        return `{\\k${durCs}}${escapeAssText(w.word)}`;
      })
      .join(' ');
    lines.push(
      `Dialogue: 0,${formatAssTime(segment.start)},${formatAssTime(segment.end)},Default,,0,0,0,,${text}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Scale caption size to the video height (clamped to a readable range). */
export function fontSizeForHeight(height: number): number {
  if (!height || height <= 0) return 48;
  return Math.min(64, Math.max(28, Math.round(height * 0.05)));
}

export function marginVForHeight(height: number): number {
  if (!height || height <= 0) return 60;
  return Math.round(height * 0.08);
}
