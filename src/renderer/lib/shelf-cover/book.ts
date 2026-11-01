/**
 * The book as every cover style reads it: its chapters in reading order, how
 * long each runs next to the book's usual chapter, and each storyline's
 * colour and the chapters it carries. A book whose storylines carry no
 * chapter yet is read as one neutral strand through the whole book, so its
 * cover still shows its length.
 */
import { COVER_HEIGHT, COVER_WIDTH, hexColor, type Paint, type RGB } from './paint';

export interface CoverRequest {
  seed: number;
  /** Chapters in the book, in reading order. */
  chapters: number;
  /** Each storyline's colour and chapters, as indexes in reading order. */
  storylines: ReadonlyArray<{ color: string; chapters: readonly number[] }>;
  /** Each chapter's words, in reading order. */
  words: readonly number[];
  /** The title is written in Latin letters (the type a cover of characters sets). */
  latin: boolean;
}

export interface Strand {
  rgb: RGB;
  /** 1 for each chapter the storyline carries. */
  on: Uint8Array;
  /** Its presence down the book, softened, one value per row of the cover. */
  level: Float32Array;
  neutral: boolean;
}

export interface CoverBook {
  chapters: number;
  words: number[];
  /** Each chapter's words over the book's mean (1 when nothing is counted). */
  wn: number[];
  /** `wn` down the book, softened, one value per row of the cover. */
  wordLevel: Float32Array;
  strands: Strand[];
  latin: boolean;
}

/** What a full-colour style draws: the whole cover, light or dark under the title. */
export interface ArtStyle {
  draw(ctx: Paint, book: CoverBook, rand: () => number): { dark: boolean };
}

/** A storyline's presence, softened, in `samples` steps down the book; `weights` scale its chapters. */
export function presence(
  samples: number,
  chapters: number,
  own: readonly number[] | null,
  weights?: readonly number[],
): Float32Array {
  const n = Math.max(1, chapters);
  const level = new Float32Array(n);
  if (own === null) level.fill(0.55);
  else own.forEach((index, k) => { if (index >= 0 && index < n) level[index] = weights ? weights[k] : 1; });
  const raw = new Float32Array(samples);
  for (let y = 0; y < samples; y++) {
    const at = n === 1 ? 0 : (y / (samples - 1)) * (n - 1);
    const i0 = Math.min(n - 1, Math.floor(at));
    const i1 = Math.min(n - 1, i0 + 1);
    raw[y] = level[i0] + (level[i1] - level[i0]) * (at - i0);
  }
  // A moving average, so a strand swells into its chapters rather than
  // stepping; beyond the ends counts as absent, so every strand tapers in and out.
  const window = Math.max(3, Math.round((17 * samples) / COVER_HEIGHT) | 1);
  const half = window >> 1;
  const prefix = new Float32Array(samples + 1);
  for (let y = 0; y < samples; y++) prefix[y + 1] = prefix[y] + raw[y];
  const out = new Float32Array(samples);
  for (let y = 0; y < samples; y++) {
    out[y] = (prefix[Math.min(samples, y + half + 1)] - prefix[Math.max(0, y - half)]) / window;
  }
  return out;
}

/** Each chapter's words over the book's mean; 1 throughout when nothing is counted. */
export function relativeWords(chapters: number, words: readonly number[]): number[] {
  const n = Math.max(1, chapters);
  const counts = Array.from({ length: n }, (_, c) => Math.max(0, words[c] ?? 0));
  const mean = counts.reduce((a, b) => a + b, 0) / n;
  return counts.map((w) => (mean > 0 ? w / mean : 1));
}

const NEUTRAL = '#55524E';

export function readCoverBook(request: CoverRequest): CoverBook {
  const n = Math.max(1, request.chapters);
  const wn = relativeWords(n, request.words);
  const all = Array.from({ length: n }, (_, c) => c);
  const strand = (color: string, chapters: readonly number[], neutral: boolean): Strand => {
    const on = new Uint8Array(n);
    for (const c of chapters) if (c >= 0 && c < n) on[c] = 1;
    return { rgb: hexColor(color), on, level: presence(COVER_HEIGHT, n, chapters), neutral };
  };
  const carried = request.storylines.some((line) => line.chapters.length > 0);
  return {
    chapters: n,
    words: all.map((c) => request.words[c] ?? 0),
    wn,
    wordLevel: presence(COVER_HEIGHT, n, all, wn),
    strands: carried
      ? request.storylines.map((line) => strand(line.color, line.chapters, false))
      : [strand(NEUTRAL, all, true)],
    latin: request.latin,
  };
}

/* ── Small readings shared by the styles ─────────────────────────────── */

/** The cover row for a point `t` (0–1) down the book. */
export const rowAt = (t: number) => Math.round(Math.max(0, Math.min(1, t)) * (COVER_HEIGHT - 1));

export function mean(values: ArrayLike<number>, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i <= to; i++) sum += values[i];
  return sum / (to - from + 1);
}

/** Where each of `n` strands sits across the cover, in the author's order. */
export const lanesOf = (n: number) =>
  Array.from({ length: n }, (_, i) => COVER_WIDTH * (n === 1 ? 0.5 : 0.22 + (0.56 * i) / (n - 1)));

/** Runs of chapters a strand carries, as [first, last]. */
export function runs(on: Uint8Array): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let c = 0; c < on.length; c++) {
    if (!on[c]) continue;
    const first = c;
    while (c + 1 < on.length && on[c + 1]) c++;
    out.push([first, c]);
  }
  return out;
}

/** Runs joined where no more than `gap` chapters part them. */
export function mergeRuns(list: Array<[number, number]>, gap: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [a, b] of list) {
    const last = out[out.length - 1];
    if (last && a - last[1] - 1 <= gap) last[1] = b;
    else out.push([a, b]);
  }
  return out;
}

/** A seeded shuffle of `list`, for styles that hand out shapes or angles. */
export function shuffled<T>(list: readonly T[], rand: () => number): T[] {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
