/**
 * The sand on a shelf cover: the book's storylines turned upright, its first
 * chapter at the top. Each storyline is one band of sand flowing down the
 * cover, side by side in the author's order; it runs thick through the
 * chapters it carries and thins to a loose thread where it is absent, so the
 * cover reads as the book's structure. A book without storylines gets one
 * band of neutral ink.
 *
 * Each band is an alpha mask (white, 0–1); the colour is laid on in CSS like
 * every sand mark (materials.css `.sand`), so a theme change needs no redraw.
 * Everything random is seeded by the book, so its cover is the same every time
 * the shelf opens. Sizes are mask px: twice the 126 × 226 cover.
 */

export const COVER_MASK_WIDTH = 252;
export const COVER_MASK_HEIGHT = 452;

export interface SandCoverRequest {
  seed: number;
  /** Chapters in the book, in reading order. */
  chapters: number;
  /** Each storyline's chapters, as indexes in reading order. Empty: one neutral band. */
  storylines: ReadonlyArray<{ chapters: readonly number[] }>;
  width?: number;
  height?: number;
}

/** A stable seed for a book from its id (FNV-1a). */
export function coverSeed(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Smooth noise along one axis, 0–1, varying over about `cell` px. */
function noise1d(n: number, cell: number, rand: () => number): Float32Array {
  const grid = Array.from({ length: Math.floor(n / cell) + 3 }, rand);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = i / cell;
    const i0 = Math.floor(u);
    const t = smooth(u - i0);
    out[i] = grid[i0] * (1 - t) + grid[i0 + 1] * t;
  }
  return out;
}

/** Smooth noise over the mask, 0–1, varying over about `cell` px. */
function noise2d(h: number, w: number, cell: number, rand: () => number): Float32Array {
  const gw = Math.floor(w / cell) + 3;
  const gh = Math.floor(h / cell) + 3;
  const grid = Array.from({ length: gw * gh }, rand);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const v = y / cell;
    const y0 = Math.floor(v);
    const ty = smooth(v - y0);
    for (let x = 0; x < w; x++) {
      const u = x / cell;
      const x0 = Math.floor(u);
      const tx = smooth(u - x0);
      const a = grid[y0 * gw + x0];
      const b = grid[y0 * gw + x0 + 1];
      const c = grid[(y0 + 1) * gw + x0];
      const d = grid[(y0 + 1) * gw + x0 + 1];
      out[y * w + x] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
  }
  return out;
}

/** How strongly the storyline is present on each row: its chapters, spread down the cover and softened. */
function presence(rows: number, chapters: number, own: readonly number[] | null): Float32Array {
  const n = Math.max(1, chapters);
  const level = new Float32Array(n);
  if (own === null) level.fill(0.5);
  else if (chapters === 0) level.fill(0.3);
  else for (const index of own) if (index >= 0 && index < n) level[index] = 1;

  const raw = new Float32Array(rows);
  for (let y = 0; y < rows; y++) {
    const at = n === 1 ? 0 : (y / (rows - 1)) * (n - 1);
    const i0 = Math.min(n - 1, Math.floor(at));
    const i1 = Math.min(n - 1, i0 + 1);
    raw[y] = level[i0] + (level[i1] - level[i0]) * (at - i0);
  }
  // A moving average, so a band swells into its chapters rather than stepping;
  // beyond the ends counts as absent, so every band tapers in and out.
  const window = Math.max(3, Math.round((31 * rows) / COVER_MASK_HEIGHT) | 1);
  const half = window >> 1;
  const prefix = new Float32Array(rows + 1);
  for (let y = 0; y < rows; y++) prefix[y + 1] = prefix[y] + raw[y];
  const out = new Float32Array(rows);
  for (let y = 0; y < rows; y++) {
    out[y] = (prefix[Math.min(rows, y + half + 1)] - prefix[Math.max(0, y - half)]) / window;
  }
  return out;
}

/** One alpha mask per storyline (or one neutral band), row by row, `width × height`. */
export function drawSandCover({
  seed,
  chapters,
  storylines,
  width: w = COVER_MASK_WIDTH,
  height: h = COVER_MASK_HEIGHT,
}: SandCoverRequest): Float32Array[] {
  const rand = random(seed);
  const s = w / COVER_MASK_WIDTH;
  const lines: Array<readonly number[] | null> = storylines.length
    ? storylines.map((line) => line.chapters)
    : [null];
  const n = lines.length;
  const maxWidth = (n > 3 ? 40 : 52) * s;
  const turn = rand() * Math.PI * 2;

  return lines.map((own, index) => {
    const level = presence(h, chapters, own);
    const drift = noise1d(h, 120, rand);
    const ragged = noise1d(h, 25, rand);
    const strata = noise2d(h, w, 30, rand);
    const phase = index * 1.9 + turn;
    const centreX = w * (n === 1 ? 0.5 : 0.26 + (0.56 * index) / (n - 1));
    const alpha = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const l = level[y];
      const flow = Math.sin((y / (h - 1)) * Math.PI * 2 * 0.9 + phase) * 0.5 + (drift[y] - 0.5) * 0.8;
      const centre = centreX + flow * 18 * s;
      const half = Math.max(0.5, (maxWidth * (0.12 + 0.88 * l) + (ragged[y] - 0.5) * 4 * s) / 2);
      const load = 0.3 + 0.7 * l;
      const reach = Math.ceil(half * 2.2);
      const x0 = Math.max(0, Math.floor(centre - reach));
      const x1 = Math.min(w - 1, Math.ceil(centre + reach));
      for (let x = x0; x <= x1; x++) {
        const dist = Math.abs(x - centre) / half;
        const density = Math.max(0, Math.min(1, 1.25 - dist)) ** 1.3 * load;
        const layers = 0.75 + 0.25 * Math.sin((x - centre) * 0.9 + strata[y * w + x] * 6);
        let a = rand() < density * layers ? 0.62 + 0.38 * rand() : 0;
        a += density * 0.35;
        // Loose grains thrown off the band's edge.
        if (dist < 2.2 && rand() < 0.012 * (0.3 + l)) a = Math.max(a, 0.5);
        alpha[y * w + x] = Math.min(1, a);
      }
    }
    return alpha;
  });
}

/** The mask as a PNG data URL for CSS (`--sand-mask`), or null where there is no canvas. */
export function sandCoverMaskUrl(alpha: Float32Array, width = COVER_MASK_WIDTH, height = COVER_MASK_HEIGHT): string | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  const image = context.createImageData(width, height);
  for (let i = 0; i < alpha.length; i++) {
    image.data[i * 4] = 255;
    image.data[i * 4 + 1] = 255;
    image.data[i * 4 + 2] = 255;
    image.data[i * 4 + 3] = Math.round(alpha[i] * 255);
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

/* ── The shelf's covers, drawn once a session ──────────────────────── */

const COVER_CACHE_LIMIT = 160;
const drawnCovers = new Map<string, string[]>();
const waiting = new Map<string, { request: SandCoverRequest; listeners: Set<(masks: string[]) => void> }>();
let drawing = false;

/** What a cover's sand depends on: the book, its length and where each storyline runs. Colours are CSS. */
export function sandCoverKey(
  id: string,
  chapters: number,
  storylines: ReadonlyArray<{ chapters: readonly number[] }>,
  size: { width: number; height: number } = { width: COVER_MASK_WIDTH, height: COVER_MASK_HEIGHT },
): string {
  const lines = storylines.map((line) => line.chapters.join('.')).join('/');
  return `${id}|${size.width}x${size.height}|${chapters}|${lines}`;
}

export function peekSandCoverMasks(key: string): string[] | null {
  return drawnCovers.get(key) ?? null;
}

/**
 * Draws a cover's masks off the main path: one book per task, so a shelf of
 * many books never holds up a frame. Returns a cancel for the listener.
 */
export function requestSandCoverMasks(
  key: string,
  request: SandCoverRequest,
  listener: (masks: string[]) => void,
): () => void {
  const done = drawnCovers.get(key);
  if (done) {
    listener(done);
    return () => {};
  }
  const entry = waiting.get(key) ?? { request, listeners: new Set() };
  entry.listeners.add(listener);
  waiting.set(key, entry);
  if (!drawing) {
    drawing = true;
    setTimeout(drawNextCover, 0);
  }
  return () => {
    entry.listeners.delete(listener);
    if (!entry.listeners.size && waiting.get(key) === entry) waiting.delete(key);
  };
}

function drawNextCover() {
  const next = waiting.entries().next();
  if (next.done) {
    drawing = false;
    return;
  }
  const [key, { request, listeners }] = next.value;
  waiting.delete(key);
  const masks = drawSandCover(request)
    .map((alpha) => sandCoverMaskUrl(alpha, request.width, request.height))
    .filter((url): url is string => url !== null);
  drawnCovers.set(key, masks);
  if (drawnCovers.size > COVER_CACHE_LIMIT) drawnCovers.delete(drawnCovers.keys().next().value!);
  for (const listener of listeners) listener(masks);
  setTimeout(drawNextCover, 0);
}
