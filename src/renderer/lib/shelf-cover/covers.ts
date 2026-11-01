/**
 * The shelf's covers, drawn once a session per book and style: in the worker
 * where the WebView has OffscreenCanvas (and for styles that need no page
 * fonts), else on the page one book per task, so a shelf of many books never
 * holds up a frame. Kept as object URLs, the least recently shown let go.
 */
import { chapterWeight } from '../sand-cover';
import { relativeWords, type CoverRequest } from './book';
import { drawCoverFiles, type DrawnCoverFiles } from './draw';
import { TYPE_STYLES, type CoverStyleId } from './styles';

export interface ShelfCover {
  style: CoverStyleId;
  /** Sand: one mask per stroke. Any other style: the whole cover. */
  urls: string[];
  /** Sand drawn for a book whose storylines carry no chapter: one stroke of neutral ink. */
  neutral: boolean;
  /** The cover's ground is dark under the title. */
  dark: boolean;
}

const COVER_CACHE_LIMIT = 240;
const drawn = new Map<string, ShelfCover>();

interface Waiting {
  style: CoverStyleId;
  request: CoverRequest;
  listeners: Set<(cover: ShelfCover) => void>;
}
const waiting = new Map<string, Waiting>();
let drawing = false;

/** What a cover depends on: the book, the style, its length, where each storyline runs and how heavily. Colours are drawn in. */
export function shelfCoverKey(id: string, style: CoverStyleId, request: Omit<CoverRequest, 'seed'>): string {
  const weights = relativeWords(request.chapters, request.words).map((w) => Math.round(chapterWeight(w) * 10)).join('');
  const lines = request.storylines.map((line) => `${style === 'sand' ? '' : line.color}${line.chapters.join('.')}`).join('/');
  return `${style}|${id}|${request.chapters}|${request.latin ? 'l' : 'h'}|${lines}|${weights}`;
}

export function peekShelfCover(key: string): ShelfCover | null {
  const cover = drawn.get(key);
  if (!cover) return null;
  // Shown again, so the last to be let go.
  drawn.delete(key);
  drawn.set(key, cover);
  return cover;
}

/** Draws a cover off the main path, one book at a time. Returns a cancel for the listener. */
export function requestShelfCover(
  key: string,
  style: CoverStyleId,
  request: CoverRequest,
  listener: (cover: ShelfCover) => void,
): () => void {
  const done = peekShelfCover(key);
  if (done) {
    listener(done);
    return () => {};
  }
  if (typeof document === 'undefined') return () => {};
  const entry = waiting.get(key) ?? { style, request, listeners: new Set() };
  entry.listeners.add(listener);
  waiting.set(key, entry);
  if (!drawing) {
    drawing = true;
    setTimeout(drawNext, 0);
  }
  return () => {
    entry.listeners.delete(listener);
    if (!entry.listeners.size && waiting.get(key) === entry) waiting.delete(key);
  };
}

/* ── Where covers are drawn ──────────────────────────────────────────── */

let worker: Worker | null | undefined;
let workerJob: { id: number; resolve: (files: DrawnCoverFiles) => void; reject: (error: Error) => void } | null = null;
let nextJob = 0;
let pageCanvas: HTMLCanvasElement | null = null;

function coverWorker(): Worker | null {
  if (worker !== undefined) return worker;
  worker = null;
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return null;
  try {
    const w = new Worker(new URL('./shelf-cover.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<{ id: number; files?: Blob[]; dark?: boolean; error?: string }>) => {
      const job = workerJob;
      if (!job || job.id !== e.data.id) return;
      workerJob = null;
      if (e.data.files) job.resolve({ files: e.data.files, dark: !!e.data.dark });
      else job.reject(new Error(e.data.error ?? 'The cover worker drew nothing.'));
    };
    w.onerror = () => {
      // A worker that cannot run gives way to the page for good.
      worker = null;
      workerJob?.reject(new Error('The cover worker failed.'));
      workerJob = null;
      w.terminate();
    };
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

function drawOnPage(style: CoverStyleId, request: CoverRequest): Promise<DrawnCoverFiles> {
  pageCanvas ??= document.createElement('canvas');
  return drawCoverFiles(style, request, pageCanvas);
}

function drawFiles(style: CoverStyleId, request: CoverRequest): Promise<DrawnCoverFiles> {
  const w = TYPE_STYLES.has(style) ? null : coverWorker();
  if (!w) return drawOnPage(style, request);
  return new Promise<DrawnCoverFiles>((resolve, reject) => {
    workerJob = { id: ++nextJob, resolve, reject };
    w.postMessage({ id: workerJob.id, style, request });
  }).catch(() => {
    worker = null;
    w.terminate();
    return drawOnPage(style, request);
  });
}

function drawNext() {
  const next = waiting.entries().next();
  if (next.done) {
    drawing = false;
    return;
  }
  const [key, { style, request }] = next.value;
  drawFiles(style, request).then(
    ({ files, dark }) => {
      const cover: ShelfCover = {
        style,
        urls: files.map((file) => URL.createObjectURL(file)),
        neutral: !request.storylines.some((line) => line.chapters.length > 0),
        dark,
      };
      drawn.set(key, cover);
      while (drawn.size > COVER_CACHE_LIMIT) {
        const [oldest, old] = drawn.entries().next().value!;
        drawn.delete(oldest);
        for (const url of old.urls) URL.revokeObjectURL(url);
      }
      const entry = waiting.get(key);
      waiting.delete(key);
      for (const listener of entry?.listeners ?? []) listener(cover);
    },
    () => {
      // Nothing to show for this book; it stays a plain slip of paper.
      waiting.delete(key);
    },
  ).finally(() => setTimeout(drawNext, 0));
}
