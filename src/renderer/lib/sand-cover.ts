/**
 * The sand on a shelf cover (the shelf's first cover style): the book's
 * storylines turned upright, its first chapter at the top. Each storyline is
 * one sand stroke scribbled down the cover by a hand with momentum: it sweeps
 * from side to side, overshoots a little and comes round, now and then carries
 * on down instead of turning back, and the book is read along the stroke, so
 * every sweep is a stretch of chapters. The stroke runs thick through the
 * chapters the storyline carries, the more so where they are long, and thins to
 * a loose thread where it is absent; the hand's pressure wanders over that, so
 * the cover follows the book's structure without charting it. The strokes keep
 * the author's order from left to right, each about its own lane, and cross
 * where their sweeps meet. A book whose storylines carry no chapter gets one
 * stroke of neutral ink.
 *
 * Each stroke is an alpha mask (white, 0–1); the colour is laid on in CSS like
 * every sand mark (materials.css `.sand`), so a theme change needs no redraw.
 * Everything random is seeded by the book, so its cover is the same every time
 * the shelf opens. Sizes are mask px: twice the 126 × 226 cover.
 */
import { presence, relativeWords } from './shelf-cover/book';
import { clamp, noise1d, noise2d, random, type Point } from './shelf-cover/paint';

export const COVER_MASK_WIDTH = 252;
export const COVER_MASK_HEIGHT = 452;
const W = COVER_MASK_WIDTH;
const H = COVER_MASK_HEIGHT;

export interface SandCoverRequest {
  seed: number;
  /** Chapters in the book, in reading order. */
  chapters: number;
  /** Each storyline's chapters, as indexes in reading order. None carrying a chapter: one neutral stroke. */
  storylines: ReadonlyArray<{ chapters: readonly number[] }>;
  /** Each chapter's words, in reading order, where known. */
  words?: readonly number[];
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

/**
 * How heavily a chapter lies on its stroke: a chapter of the book's usual
 * length weighs 1, an empty one about half, a long one up to half again;
 * rounded to tenths, so a few more words leave the cover as it was.
 */
export function chapterWeight(relative: number): number {
  return Math.round(Math.min(1.5, 0.45 + 0.55 * Math.sqrt(relative)) * 10) / 10;
}

/** One writer's hand for one cover: how fast it drops, how far it reaches, how tightly it turns. */
function makeHand(rand: () => number) {
  return {
    pace: 0.055 + 0.07 * rand(),
    vmax: 2.6 + 2.4 * rand(),
    accel: 0.3 + 0.9 * rand(),
    damp: 0.86 + 0.09 * rand(),
    jitter: rand() * 0.3,
    reachMin: 0.05 + 0.3 * rand(),
    carry: 0.06 + 0.16 * rand(),
    wander: 0.4 + rand(),
    swing: 0.75 + 0.5 * rand(),
    bold: 0.7 + 0.6 * rand(),
    pressureVar: 0.2 + 0.4 * rand(),
    pressureCell: 40 + 100 * rand(),
  };
}
type Hand = ReturnType<typeof makeHand>;

/**
 * A pen with momentum steered from side to side down the cover, from above it
 * to below it: it overshoots a little and comes round, so its turns are tight
 * or loose as the hand is.
 */
function penPath(lane: number, swing: number, hand: Hand, rand: () => number): Point[] {
  const wander = noise1d(160, 4, rand);
  let side = rand() < 0.5 ? -1 : 1;
  const p = { x: lane + side * swing * 0.4, y: -24 };
  let k = 0;
  let ty = p.y;
  let vmax = hand.vmax;
  const pace = H * hand.pace * (0.85 + 0.3 * rand());
  const next = () => {
    k++;
    // Now and then the hand carries on down the same side instead of turning back.
    const carry = rand() < hand.carry;
    if (!carry) side = -side;
    ty += pace * (carry ? 1.2 + 1.2 * rand() : 0.45 + 1.1 * rand());
    vmax = hand.vmax * (0.7 + 0.6 * rand());
    const centre = lane + (wander[k % 160] - 0.5) * swing * hand.wander;
    const reach = hand.reachMin + (1 - hand.reachMin) * rand() ** 0.8;
    return { x: clamp(centre + side * swing * (carry ? 0.3 + 0.5 * rand() : reach), 5, W - 5), y: ty, carry };
  };
  let target = next();
  const v = { x: side * hand.vmax * 0.6, y: 0.6 };
  const pts: Point[] = [{ x: p.x, y: p.y }];
  let since = 0;
  for (let i = 0; i < 20000 && p.y < H + 24; i++) {
    const dx = target.x - p.x;
    const dy = target.y - p.y;
    const d = Math.hypot(dx, dy) || 1;
    v.x = v.x * hand.damp + (dx / d) * hand.accel + (rand() - 0.5) * hand.jitter;
    v.y = v.y * hand.damp + (dy / d) * hand.accel + (rand() - 0.5) * hand.jitter;
    const sp = Math.hypot(v.x, v.y);
    if (sp > vmax) {
      v.x *= vmax / sp;
      v.y *= vmax / sp;
    }
    p.x += v.x;
    p.y += v.y;
    pts.push({ x: p.x, y: p.y });
    since++;
    const passed = target.carry ? p.y >= target.y : side > 0 ? p.x >= target.x : p.x <= target.x;
    if (passed || d < 6 || since > 300) {
      target = next();
      since = 0;
    }
  }
  return pts;
}

interface Sample extends Point {
  nx: number;
  ny: number;
  /** How heavily the book lies here, 0–1. */
  l: number;
  half: number;
}

/** The path at 1 px steps, each step with its width; the book is read along it from where it enters the cover to where it leaves. */
function strokeSamples(pts: readonly Point[], level: Float32Array, hand: Hand, maxHalf: number, rand: () => number): Sample[] {
  const out: Point[] = [{ x: pts[0].x, y: pts[0].y }];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    let d = 1 - carry;
    while (d <= len) {
      out.push({ x: a.x + ((b.x - a.x) * d) / len, y: a.y + ((b.y - a.y) * d) / len });
      d += 1;
    }
    carry = len - (d - 1);
  }
  const n = out.length;
  let top = 0;
  let bottom = n - 1;
  for (let i = 0; i < n; i++) if (out[i].y >= 0) { top = i; break; }
  for (let i = top; i < n; i++) if (out[i].y >= H - 1) { bottom = i; break; }
  const pressure = noise1d(n + 1, hand.pressureCell, rand);
  const ragged = noise1d(n + 1, 10, rand);
  const pv = hand.pressureVar;
  return out.map((s, i) => {
    const a = out[Math.max(0, i - 2)];
    const b = out[Math.min(n - 1, i + 2)];
    const dl = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const t = clamp((i - top) / Math.max(1, bottom - top), 0, 1);
    const asked = level[Math.round(t * (level.length - 1))];
    // What the chapters here ask for, under a hand whose pressure wanders.
    const l = clamp((asked * (1 - pv + 2 * pv * pressure[i])) / 1.25, 0, 1);
    return {
      x: s.x,
      y: s.y,
      nx: -(b.y - a.y) / dl,
      ny: (b.x - a.x) / dl,
      l,
      half: Math.max(0.7, maxHalf * (0.14 + 0.86 * l) + (ragged[i] - 0.5) * 2.4),
    };
  });
}

/** One alpha mask per storyline (or one neutral stroke), row by row, 252 × 452. */
export function drawSandCover({ seed, chapters, storylines, words = [] }: SandCoverRequest): Float32Array[] {
  const rand = random(seed);
  const hand = makeHand(rand);
  const relative = relativeWords(chapters, words);
  const lines: Array<readonly number[] | null> = storylines.some((line) => line.chapters.length > 0)
    ? storylines.map((line) => line.chapters)
    : [null];
  const n = lines.length;
  const base = n <= 1 ? 14 : n <= 3 ? 12.5 : 9;
  const swing = W * (n === 1 ? 0.34 : n === 2 ? 0.27 : n === 3 ? 0.22 : 0.15) * hand.swing;

  return lines.map((own, index) => {
    const level = own === null
      ? presence(H, chapters, null)
      : presence(H, chapters, own, own.map((c) => chapterWeight(relative[c] ?? 1)));
    const lane = W * (n === 1 ? 0.5 : 0.22 + (0.56 * index) / (n - 1)) + (rand() - 0.5) * W * 0.06;
    const samples = strokeSamples(penPath(lane, swing, hand, rand), level, hand, base * hand.bold, rand);

    // How much sand each px holds, which way across the stroke it lies, and
    // how likely a loose grain is to land there.
    const sand = new Float32Array(W * H);
    const across = new Float32Array(W * H);
    const loose = new Float32Array(W * H);
    for (let k = 0; k < samples.length; ) {
      const s = samples[k];
      const load = 0.38 + 0.62 * s.l;
      const reach = s.half * 2.2;
      const x0 = Math.max(0, Math.floor(s.x - reach));
      const x1 = Math.min(W - 1, Math.ceil(s.x + reach));
      const y0 = Math.max(0, Math.floor(s.y - reach));
      const y1 = Math.min(H - 1, Math.ceil(s.y + reach));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x - s.x;
          const dy = y - s.y;
          const dist = Math.hypot(dx, dy) / s.half;
          if (dist >= 2.2) continue;
          const i = y * W + x;
          if (0.3 + s.l > loose[i]) loose[i] = 0.3 + s.l;
          const density = Math.max(0, Math.min(1, 1.25 - dist)) ** 1.3 * load;
          if (density > sand[i]) {
            sand[i] = density;
            across[i] = dx * s.nx + dy * s.ny;
          }
        }
      }
      k += Math.max(1, Math.round(s.half * 0.3));
    }

    const strata = noise2d(30, rand);
    const alpha = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
      if (!loose[i]) continue;
      const density = sand[i];
      const layers = 0.75 + 0.25 * Math.sin(across[i] * 0.9 + strata[i] * 6);
      let a = rand() < density * layers ? 0.62 + 0.38 * rand() : 0;
      a += density * 0.35;
      // Loose grains thrown off the stroke's edge.
      if (rand() < 0.012 * loose[i]) a = Math.max(a, 0.5);
      alpha[i] = Math.min(1, a);
    }
    return alpha;
  });
}
