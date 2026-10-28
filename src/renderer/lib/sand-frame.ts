/**
 * The dry-brush frame round a selected sidebar cell, drawn for the cell's own
 * size (components/ui/SandFrame paints it). The centreline starts beside the
 * mark on the left side and runs down, along the bottom, up the right side,
 * along the top and back down past the start, or stops just short of it.
 * Every corner and side is jittered, the brush turns round the corners and
 * wavers along the line; it presses as it lands, dries as it goes until its
 * hairs part into streaks, and flicks off. Grain and a few loose grains
 * finish it. Widths are px and never stretch with the cell.
 *
 * Everything random is keyed to where it sits on its own side: the left side
 * by height, the top and bottom by distance from the left, the right side by
 * height and by its distance from the right edge. Redrawing the same seed at
 * another width therefore keeps the left side as it was, carries the right
 * side with the edge and runs the top and bottom on, so nothing crawls while
 * a sidebar is dragged wider.
 */

/** Room round the frame box for the stroke's width, overshoot and loose grains, px. */
export const SAND_FRAME_PAD = 5;

export interface SandStrokeRequest {
  /** The frame box, px: the line's centre runs round it. */
  width: number;
  height: number;
  dpr: number;
  seed: number;
  /** The box width the stroke was first drawn at; keeps its drying stable when resized. */
  nominalWidth?: number;
}

export interface SandStroke {
  /** Device px, the frame box plus SAND_FRAME_PAD on every side. */
  width: number;
  height: number;
  /** 0–1 per device px. */
  alpha: Float32Array;
  /** When (0–1 along the stroke) the brush reached each device px; above 1 where it never did. */
  arrive: Float32Array;
}

const PAD = SAND_FRAME_PAD;
const STEP = 0.5;
const HAIRS = 9;
/** Within this many px of the right edge, shape and grain follow that edge. */
const RIGHT_ZONE = 14;

export function newSandSeed() {
  return Math.floor(Math.random() * 4294967296) >>> 0;
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

function hash(seed: number, x: number, y: number) {
  let h = (seed ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

type Waver = (u: number) => number;

function waver(rand: () => number, specs: ReadonlyArray<readonly [number, number]>): Waver {
  const parts = specs.map(([length, amp]) => ({
    k: (2 * Math.PI) / (length * (0.75 + 0.5 * rand())),
    p: rand() * 2 * Math.PI,
    amp,
  }));
  return (u) => {
    let v = 0;
    for (const part of parts) v += part.amp * Math.sin(part.k * u + part.p);
    return v;
  };
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** One side's leg: 0 left going down, 1 bottom, 2 right, 3 top, 4 left closing. */
interface Sample {
  x: number;
  y: number;
  leg: number;
  /** Where the sample sits on its own side (see the module comment). */
  u: number;
  /** Drying, 0–1, from the nominal perimeter. */
  q: number;
  /** Px from the start (leg 0) or to the end (leg 4); otherwise Infinity. */
  fromStart: number;
  toEnd: number;
}

export function drawSandStroke({ width: w, height: h, dpr, seed, nominalWidth = w }: SandStrokeRequest): SandStroke {
  const rand = random(seed);
  const J = (a: number) => (rand() - 0.5) * 2 * a;
  const left = PAD;
  const right = PAD + w;
  const top = PAD;
  const bottom = PAD + h;

  // Corners. The right two keep their offset from the right edge.
  const tl = { x: left + J(1.2), y: top + J(0.9) };
  const trDx = J(1.2);
  const trY = top + J(0.9);
  const brDx = J(1.2);
  const brY = bottom + J(0.9);
  const bl = { x: left + J(1.2), y: bottom + J(0.9) };
  const tr = { x: right + trDx, y: trY };
  const br = { x: right + brDx, y: brY };
  const side = bl.y - tl.y;
  const f = 0.5 + J(0.08);
  const start = { x: tl.x + (bl.x - tl.x) * f + J(0.4), y: tl.y + side * f };
  // Close by running a few px past the start, or stop just short of it.
  const over = rand() < 0.28 ? -(1.5 + rand() * 4) : 3 + rand() * Math.min(11, side * 0.35);
  const endY = Math.min(bl.y - side * 0.04, Math.max(tl.y + side * 0.1, start.y + over));
  const end = { x: tl.x + (bl.x - tl.x) * ((endY - tl.y) / side) + J(1.1), y: endY };

  const wob = [0, 1, 2, 3, 4].map(() => waver(rand, [[110, 0.6], [36, 0.3], [12, 0.12]]));
  const bend = [waver(rand, [[420, 0.7]]), waver(rand, [[420, 0.7]])];
  const turn = 4 + Math.round(rand() * 4);
  const dry = 0.4 + 0.24 * rand();
  const thick = 2 + 0.4 * rand();
  const breadth = waver(rand, [[23, 0.2], [7, 0.07]]);
  const press = waver(rand, [[41, 0.07]]);
  const hairs = Array.from({ length: HAIRS }, () => ({ t: rand(), k: (2 * Math.PI) / (30 + rand() * 60), p: rand() * 2 * Math.PI }));

  const perimeter = 2 * (nominalWidth + h);
  const qa = (bl.y - start.y) / perimeter;
  const qb = qa + nominalWidth / perimeter;
  const qc = qb + h / perimeter;
  const qd = qc + nominalWidth / perimeter;

  const raw: Sample[] = [];
  const push = (x: number, y: number, leg: number, u: number, q: number, fromStart = Infinity, toEnd = Infinity) => {
    raw.push({ x, y, leg, u, q, fromStart, toEnd });
  };
  // The top and bottom stay level until the last few px before the right
  // corner, so their left parts do not tilt as the right edge moves.
  const levelBottom = (x: number) => bl.y + (br.y - bl.y) * smoothstep(right - 24, right, x);
  const levelTop = (x: number) => tl.y + (tr.y - tl.y) * smoothstep(right - 24, right, x);

  for (let y = start.y; y < bl.y; y += STEP) {
    const t = (y - start.y) / (bl.y - start.y);
    push(start.x + (bl.x - start.x) * t + wob[0](y), y, 0, y, (y - start.y) / perimeter, y - start.y);
  }
  for (let x = bl.x; x < br.x; x += STEP) {
    push(x, levelBottom(x) + wob[1](x - left) + bend[0](x - left), 1, x - left, qa + (x - bl.x) / perimeter);
  }
  for (let y = br.y; y > tr.y; y -= STEP) {
    const t = (br.y - y) / (br.y - tr.y);
    push(br.x + (tr.x - br.x) * t + wob[2](y), y, 2, y, qb + (br.y - y) / perimeter);
  }
  // Sampled on a grid from the left so the samples do not slide with the edge.
  const topSteps = Math.floor((tr.x - tl.x) / STEP);
  push(tr.x, levelTop(tr.x) + wob[3](tr.x - left) + bend[1](tr.x - left), 3, tr.x - left, qc);
  for (let i = topSteps; i >= 0; i--) {
    const x = tl.x + i * STEP;
    const back = Math.max(0, left + nominalWidth - x);
    push(x, levelTop(x) + wob[3](x - left) + bend[1](x - left), 3, x - left, Math.min(qd, qc + back / perimeter));
  }
  for (let y = tl.y; y <= end.y; y += STEP) {
    const t = (y - tl.y) / (end.y - tl.y || 1);
    push(tl.x + (end.x - tl.x) * t + wob[4](y), y, 4, y, qd + (y - tl.y) / perimeter, Infinity, end.y - y);
  }

  // Round the corners the way a turning brush does.
  const path = raw.map((sample, i) => {
    let ax = 0;
    let ay = 0;
    let c = 0;
    for (let k = Math.max(0, i - turn); k <= Math.min(raw.length - 1, i + turn); k++) {
      ax += raw[k].x;
      ay += raw[k].y;
      c++;
    }
    return { ...sample, x: ax / c, y: ay / c };
  });
  const along: number[] = [0];
  for (let i = 1; i < path.length; i++) along.push(along[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
  const total = along[along.length - 1] || 1;

  const W = Math.ceil((w + PAD * 2) * dpr);
  const H = Math.ceil((h + PAD * 2) * dpr);
  const alpha = new Float32Array(W * H);
  const arrive = new Float32Array(W * H).fill(2);

  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(path.length - 1, i + 1);
    const dx = path[i1].x - path[i0].x;
    const dy = path[i1].y - path[i0].y;
    const d = Math.hypot(dx, dy) || 1;
    const nx = -dy / d;
    const ny = dx / d;
    const key = p.u + p.leg * 1000;
    let load = 1 - dry * Math.pow(Math.min(1.2, p.q), 1.25) + press(key);
    let rad = (thick / 2) * (1 + breadth(key));
    if (p.fromStart < 4) load += 0.15 * (1 - p.fromStart / 4);
    rad *= 0.8 + 0.25 * Math.min(1, load);
    if (p.fromStart < 3) rad *= 1.12;
    if (p.toEnd < 7) rad *= Math.max(0.3, p.toEnd / 7);
    const R = rad * dpr;
    const cx = p.x * dpr;
    const cy = p.y * dpr;
    const dryness = Math.max(0, 1 - load);
    const when = along[i] / total;
    const x0 = Math.max(0, Math.floor(cx - R - 1));
    const x1 = Math.min(W - 1, Math.ceil(cx + R + 1));
    const y0 = Math.max(0, Math.floor(cy - R - 1));
    const y1 = Math.min(H - 1, Math.ceil(cy + R + 1));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const ox = x + 0.5 - cx;
        const oy = y + 0.5 - cy;
        const dist = Math.hypot(ox, oy);
        if (dist > R + 0.8) continue;
        const edge = Math.min(1, (R + 0.8 - dist) / 1.6);
        const across = (ox * nx + oy * ny) / Math.max(0.5, R);
        const hair = hairs[Math.min(HAIRS - 1, Math.max(0, Math.floor((across + 1) * 0.5 * HAIRS)))];
        const holds = hair.t + 0.15 * Math.sin(key * hair.k + hair.p) > dryness * 1.3 ? 1 : 0.16;
        const v = edge * Math.min(1, load) * holds;
        const at = y * W + x;
        if (v > alpha[at]) alpha[at] = v;
        if (v > 0.05 && when < arrive[at]) arrive[at] = when;
      }
    }
  }

  // Grain, keyed to the left edge or, near the right edge, to that edge.
  const rightZone = (right - RIGHT_ZONE) * dpr;
  const rightEdge = Math.round(right * dpr);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const at = y * W + x;
      const a = alpha[at];
      if (!a) continue;
      const kx = x >= rightZone ? x - rightEdge - 100000 : x;
      const grain = hash(seed, kx, y) < a * 1.1 ? 0.6 + 0.4 * hash(seed ^ 0x9e3779b9, kx, y) : 0;
      alpha[at] = a * 0.45 + grain * 0.55;
    }
  }

  // Loose grains, one chance per 40px of each side, keyed like the side.
  const legStart = [0, 0, 0, 0, 0];
  const legEnd = [0, 0, 0, 0, 0];
  path.forEach((p, i) => {
    if (!legEnd[p.leg]) legStart[p.leg] = i;
    legEnd[p.leg] = i + 1;
  });
  for (let leg = 0; leg < 5; leg++) {
    for (let i = legStart[leg]; i < legEnd[leg]; i++) {
      const p = path[i];
      const cell = Math.floor(p.u / 40);
      const prev = i > legStart[leg] ? Math.floor(path[i - 1].u / 40) : NaN;
      if (cell === prev) continue;
      const salt = leg * 7919 + cell;
      if (hash(seed, salt, 17) > 0.75) continue;
      const pick = Math.min(legEnd[leg] - 1, i + Math.floor(hash(seed, salt, 29) * 80));
      const q = path[pick];
      const offset = (hash(seed, salt, 41) < 0.5 ? -1 : 1) * thick * (0.9 + 1.8 * hash(seed, salt, 53));
      const i0 = Math.max(0, pick - 1);
      const i1 = Math.min(path.length - 1, pick + 1);
      const tx = path[i1].x - path[i0].x;
      const ty = path[i1].y - path[i0].y;
      const tlen = Math.hypot(tx, ty) || 1;
      const x = Math.round((q.x - (ty / tlen) * offset) * dpr);
      const y = Math.round((q.y + (tx / tlen) * offset) * dpr);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const at = y * W + x;
      alpha[at] = Math.max(alpha[at], 0.5);
      arrive[at] = Math.min(arrive[at], along[pick] / total);
    }
  }

  return { width: W, height: H, alpha, arrive };
}

/** Paints `stroke` in `rgb` up to `progress` (0–1 along the stroke). */
export function paintSandStroke(canvas: HTMLCanvasElement, stroke: SandStroke, rgb: readonly [number, number, number], progress: number) {
  if (canvas.width !== stroke.width) canvas.width = stroke.width;
  if (canvas.height !== stroke.height) canvas.height = stroke.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const image = ctx.createImageData(stroke.width, stroke.height);
  const data = image.data;
  for (let i = 0; i < stroke.alpha.length; i++) {
    const a = stroke.alpha[i];
    if (!a || stroke.arrive[i] > progress) continue;
    const j = i * 4;
    data[j] = rgb[0];
    data[j + 1] = rgb[1];
    data[j + 2] = rgb[2];
    data[j + 3] = Math.min(255, a * 255);
  }
  ctx.putImageData(image, 0, 0);
}

/** Reads a computed CSS colour (`rgb(…)` or WebKit's `color(srgb …)`) as 0–255 channels. */
export function rgbOfComputedColour(value: string): [number, number, number] {
  const srgb = value.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255].map(Math.round) as [number, number, number];
  const rgb = value.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return [126, 123, 119];
}
