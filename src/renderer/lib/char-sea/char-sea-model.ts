import type { CharSeaLanguage } from './char-sea-text';

/**
 * The parts of the sea that need no GPU: where each character sits, the water
 * under them (and a shape it can be held to), the loading rain, and the
 * characters that change while it loads.
 */

export interface CharSeaLayout {
  cols: number;
  rows: number;
  /** CSS px from the window's top left to the first cell's corner. */
  originX: number;
  originY: number;
  cellWidth: number;
  cellHeight: number;
  /** Each distinct character once, in order of first use. */
  glyphs: string[];
  /** One glyph index per cell, row by row from the top left. */
  map: Uint8Array;
}

// Arabic vowel marks combine with the letter before them; alone in a cell
// they would draw on a dotted circle.
const COMBINING_MARKS = /[ً-ٰٟ]/g;

/** Offset of the first cell so that a cell centre falls on the window's centre. */
function centredOrigin(extent: number, cell: number): number {
  const fromCentre = extent / 2 - cell / 2;
  return fromCentre - cell * Math.floor(fromCentre / cell);
}

/**
 * Lays the language's passage over the window one character to a cell, in
 * reading order (right to left for right-to-left scripts). A cell centre sits
 * on the window's centre, as the dots of the startup placeholder do, so the
 * page the app opens on and the sea line up.
 */
export function layoutCharSea(width: number, height: number, language: CharSeaLanguage): CharSeaLayout {
  const { cellWidth, cellHeight } = language;
  const originX = centredOrigin(width, cellWidth);
  const originY = centredOrigin(height, cellHeight);
  const cols = Math.max(1, Math.floor((width - originX) / cellWidth));
  const rows = Math.max(1, Math.floor((height - originY) / cellHeight));
  const text = Array.from(language.text.replace(COMBINING_MARKS, ''));
  const glyphs: string[] = [];
  const index = new Map<string, number>();
  const map = new Uint8Array(cols * rows);
  for (let i = 0; i < cols * rows; i += 1) {
    const ch = text[i % text.length];
    let at = index.get(ch);
    if (at === undefined) {
      at = Math.min(255, glyphs.length);
      if (glyphs.length < 256) {
        index.set(ch, at);
        glyphs.push(ch);
      }
    }
    const row = Math.floor(i / cols);
    const col = i % cols;
    map[row * cols + (language.rtl ? cols - 1 - col : col)] = at;
  }
  return { cols, rows, originX, originY, cellWidth, cellHeight, glyphs, map };
}

/** Steps of the water per second, whatever the display's frame rate. */
export const CHAR_SEA_STEP_RATE = 100;
/** One cell of water in CSS px. */
export const CHAR_SEA_WATER_CELL = 7;
// (wave speed in cells per step)²; with the 9-point Laplacian below a ring
// travels about 0.45 cells a step, about 310px a second.
const C2 = 0.2;
// Damping per step inside, and how far in from each edge the water absorbs a
// wave instead of throwing it back.
const DAMPING = 0.992;
const EDGE_DAMPING = 0.9;
const EDGE_CELLS = 16;
// A 2D ring leaves a slow swell behind it. Once the whole surface is this
// calm, it settles faster still, so a single press is still water (and the
// loop stops) in about five seconds; rings that are still travelling, and
// drops that keep falling, are not touched.
const CALM_FROM = 0.3;
const CALM_FULL = 0.05;
const CALM_DAMPING = 0.015;
// Water held to a shape (the loading word): the spring that pulls it back and
// its own damping, and how many cells round the shape are pinned to it too, so
// nothing leaks from its edges.
const HOLD_SPRING = 0.03;
const HOLD_DAMPING = 0.04;
const HOLD_MARGIN = 4;
// Let go with a burst, the word leaves from its outline only: its strokes are
// joined across gaps up to this share of its height and its holes filled, the
// edge softened over RELEASE_SOFTEN cells. For RELEASE_DRAIN_STEPS steps after,
// what lies more than RELEASE_DRAIN_DEPTH cells inside drinks its own water (at
// most RELEASE_DRAIN a step), so the middle sinks quietly instead of rebounding
// as a second ring.
const RELEASE_JOIN = 0.12;
const RELEASE_SOFTEN = 1;
const RELEASE_DRAIN_DEPTH = 2;
const RELEASE_DRAIN_STEPS = 80;
const RELEASE_DRAIN = 0.18;

/** A box blur of `radius` cells along the rows, then the columns, in place. */
function boxBlur(field: Float32Array, cols: number, rows: number, radius: number): void {
  const line = new Float32Array(Math.max(cols, rows));
  const pass = (count: number, length: number, at: (lineIndex: number, k: number) => number) => {
    for (let l = 0; l < count; l += 1) {
      for (let k = 0; k < length; k += 1) line[k] = field[at(l, k)];
      let sum = 0;
      for (let k = -radius; k <= radius; k += 1) sum += line[Math.min(length - 1, Math.max(0, k))];
      for (let k = 0; k < length; k += 1) {
        field[at(l, k)] = sum / (2 * radius + 1);
        sum += line[Math.min(length - 1, k + radius + 1)] - line[Math.max(0, k - radius)];
      }
    }
  };
  pass(rows, cols, (row, col) => row * cols + col);
  pass(cols, rows, (col, row) => row * cols + col);
}

/** Grows (`grow`) or shrinks a 0/1 mask by `radius` cells, as a square, along the rows then the columns. */
function morph(mask: Uint8Array, cols: number, rows: number, radius: number, grow: boolean): void {
  const line = new Uint8Array(Math.max(cols, rows));
  const pass = (count: number, length: number, at: (lineIndex: number, k: number) => number) => {
    for (let l = 0; l < count; l += 1) {
      for (let k = 0; k < length; k += 1) line[k] = mask[at(l, k)];
      for (let k = 0; k < length; k += 1) {
        let value = line[k];
        for (let j = Math.max(0, k - radius); j <= Math.min(length - 1, k + radius); j += 1) {
          value = grow ? value | line[j] : value & line[j];
        }
        mask[at(l, k)] = value;
      }
    }
  };
  pass(rows, cols, (row, col) => row * cols + col);
  pass(cols, rows, (col, row) => row * cols + col);
}

/** Fills whatever the mask encloses (a letter's counter): what the outside cannot reach becomes part of it. */
function fillHoles(mask: Uint8Array, cols: number, rows: number): void {
  const outside = new Uint8Array(mask.length);
  const queue: number[] = [];
  const visit = (i: number) => {
    if (mask[i] || outside[i]) return;
    outside[i] = 1;
    queue.push(i);
  };
  for (let x = 0; x < cols; x += 1) { visit(x); visit((rows - 1) * cols + x); }
  for (let y = 0; y < rows; y += 1) { visit(y * cols); visit(y * cols + cols - 1); }
  while (queue.length) {
    const i = queue.pop()!;
    const x = i % cols;
    if (x > 0) visit(i - 1);
    if (x < cols - 1) visit(i + 1);
    if (i >= cols) visit(i - cols);
    if (i < mask.length - cols) visit(i + cols);
  }
  for (let i = 0; i < mask.length; i += 1) if (!outside[i]) mask[i] = 1;
}

/**
 * A water surface over the window: the 2D wave equation on a grid of 7px
 * cells, with a 9-point Laplacian so rings stay round, and absorbing edges.
 */
export class CharSeaWater {
  readonly cols: number;
  readonly rows: number;
  private current: Float32Array;
  private previous: Float32Array;
  private next: Float32Array;
  private readonly damping: Float32Array;
  private lastPeak = 0;
  private held: { shape: Float32Array; target: Float32Array; inside: Uint8Array } | null = null;
  private holdHeight = 0;
  private drain: { inside: Float32Array; steps: number } | null = null;

  constructor(width: number, height: number) {
    this.cols = Math.max(3, Math.ceil(width / CHAR_SEA_WATER_CELL));
    this.rows = Math.max(3, Math.ceil(height / CHAR_SEA_WATER_CELL));
    const size = this.cols * this.rows;
    this.current = new Float32Array(size);
    this.previous = new Float32Array(size);
    this.next = new Float32Array(size);
    this.damping = new Float32Array(size);
    for (let y = 0; y < this.rows; y += 1) {
      for (let x = 0; x < this.cols; x += 1) {
        const edge = Math.min(x, y, this.cols - 1 - x, this.rows - 1 - y);
        const k = Math.min(1, edge / EDGE_CELLS);
        this.damping[y * this.cols + x] = EDGE_DAMPING + (DAMPING - EDGE_DAMPING) * (k * k * (3 - 2 * k));
      }
    }
  }

  /** The surface's height per cell, row by row. */
  get heights(): Float32Array {
    return this.current;
  }

  /**
   * Holds the water to a shape (each water cell's share of it, 0..1) raised to
   * `setHoldHeight`, by a spring with its own damping; null lets it go, and the
   * shape spreads as rings. With a `burst` it leaves as one ring from its
   * outline, raised `burst` times so it carries further (`release`). The
   * spring's target is compensated with the same Laplacian and damping `step`
   * uses, so at rest the water stands exactly at shape × height, and whatever
   * knocks it settles back.
   */
  hold(shape: Float32Array | null, burst = 1): void {
    if (!shape) {
      const held = this.held;
      this.held = null;
      if (held && burst !== 1) this.release(held, burst);
      return;
    }
    const w = this.cols;
    const inside = new Uint8Array(shape.length);
    const target = new Float32Array(shape.length);
    for (let i = 0; i < shape.length; i += 1) {
      if (shape[i] < 0.002) continue;
      const cx = i % w;
      const cy = (i - cx) / w;
      for (let dy = -HOLD_MARGIN; dy <= HOLD_MARGIN; dy += 1) {
        for (let dx = -HOLD_MARGIN; dx <= HOLD_MARGIN; dx += 1) {
          const x = cx + dx;
          const y = cy + dy;
          if (x > 0 && y > 0 && x < w - 1 && y < this.rows - 1) inside[y * w + x] = 1;
        }
      }
    }
    const g = shape;
    for (let i = 0; i < shape.length; i += 1) {
      if (!inside[i]) continue;
      const laplacian =
        (g[i - 1] + g[i + 1] + g[i - w] + g[i + w]) * 0.5 +
        (g[i - w - 1] + g[i - w + 1] + g[i + w - 1] + g[i + w + 1]) * 0.25 -
        3 * g[i];
      const d = this.damping[i];
      target[i] = g[i] + ((g[i] * (1 - d)) / d - C2 * laplacian) / HOLD_SPRING;
    }
    this.held = { shape, target, inside };
  }

  /**
   * The held word let go as one: only its outer outline leaves. Its strokes are
   * joined across the gaps between letters and its holes filled, so the
   * outline keeps the letters' corners but none of their inner edges. That
   * silhouette stands as high as the strokes stood, raised `burst` times, and
   * for a moment its inside drinks its own water, so one ring goes out.
   */
  private release(held: { shape: Float32Array; inside: Uint8Array }, burst: number): void {
    const { cols, rows } = this;
    const solid = new Uint8Array(held.shape.length);
    let top = rows;
    let bottom = -1;
    for (let i = 0; i < solid.length; i += 1) {
      if (held.shape[i] <= 0.3) continue;
      solid[i] = 1;
      const row = Math.floor(i / cols);
      if (row < top) top = row;
      if (row > bottom) bottom = row;
    }
    if (bottom < top) return;
    const join = Math.max(1, Math.round((bottom - top + 1) * RELEASE_JOIN));
    morph(solid, cols, rows, join, true);
    morph(solid, cols, rows, join, false);
    fillHoles(solid, cols, rows);
    const inner = solid.slice();
    morph(inner, cols, rows, RELEASE_DRAIN_DEPTH, false);
    const silhouette = Float32Array.from(solid);
    const drain = Float32Array.from(inner);
    boxBlur(silhouette, cols, rows, RELEASE_SOFTEN);
    boxBlur(drain, cols, rows, RELEASE_SOFTEN);
    let standing = 0;
    for (let i = 0; i < held.inside.length; i += 1) if (held.inside[i] && this.current[i] > standing) standing = this.current[i];
    for (const field of [this.current, this.previous]) {
      for (let i = 0; i < field.length; i += 1) {
        if (held.inside[i]) field[i] = 0;
        field[i] += standing * silhouette[i] * burst;
      }
    }
    this.drain = { inside: drain, steps: RELEASE_DRAIN_STEPS };
  }

  /** How high the held shape stands now. */
  setHoldHeight(height: number): void {
    this.holdHeight = height;
  }

  /** How far the water at (x, y) CSS px stands from its rest; a held shape counts as rest. */
  offRest(x: number, y: number): number {
    const col = Math.floor(x / CHAR_SEA_WATER_CELL);
    const row = Math.floor(y / CHAR_SEA_WATER_CELL);
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return 0;
    const i = row * this.cols + col;
    return this.current[i] - (this.held ? this.holdHeight * this.held.shape[i] : 0);
  }

  /** A Gaussian bump at (x, y) CSS px; it spreads as a ring. */
  splash(x: number, y: number, amplitude: number, radiusCells: number): void {
    this.lastPeak = Math.max(this.lastPeak, amplitude);
    const cx = x / CHAR_SEA_WATER_CELL;
    const cy = y / CHAR_SEA_WATER_CELL;
    const reach = Math.ceil(radiusCells * 3);
    const twoR2 = 2 * radiusCells * radiusCells;
    for (let row = Math.max(1, Math.floor(cy - reach)); row <= Math.min(this.rows - 2, Math.ceil(cy + reach)); row += 1) {
      for (let col = Math.max(1, Math.floor(cx - reach)); col <= Math.min(this.cols - 2, Math.ceil(cx + reach)); col += 1) {
        const d2 = (col - cx) * (col - cx) + (row - cy) * (row - cy);
        this.current[row * this.cols + col] += amplitude * Math.exp(-d2 / twoR2);
      }
    }
  }

  /** One step of the wave equation; returns the largest height left. */
  step(): number {
    const c = this.current;
    const p = this.previous;
    const n = this.next;
    const d = this.damping;
    const w = this.cols;
    const held = this.held;
    const height = this.holdHeight;
    const drain = this.drain;
    const drinking = drain ? (RELEASE_DRAIN * drain.steps) / RELEASE_DRAIN_STEPS : 0;
    const calmness = Math.min(1, Math.max(0, (CALM_FROM - this.lastPeak) / (CALM_FROM - CALM_FULL)));
    const calm = 1 - CALM_DAMPING * calmness * calmness * (3 - 2 * calmness);
    let peak = 0;
    for (let y = 1; y < this.rows - 1; y += 1) {
      const rowStart = y * w;
      for (let x = 1; x < w - 1; x += 1) {
        const i = rowStart + x;
        const laplacian =
          (c[i - 1] + c[i + 1] + c[i - w] + c[i + w]) * 0.5 +
          (c[i - w - 1] + c[i - w + 1] + c[i + w - 1] + c[i + w + 1]) * 0.25 -
          3 * c[i];
        let value = 2 * c[i] - p[i] + C2 * laplacian;
        // a held shape's spring pulls its water back to the shape and calms it
        if (held && held.inside[i]) value += HOLD_SPRING * (height * held.target[i] - c[i]) - HOLD_DAMPING * (c[i] - p[i]);
        value *= d[i] * calm;
        if (drain) value *= 1 - drinking * drain.inside[i];
        n[i] = value;
        const magnitude = value < 0 ? -value : value;
        if (magnitude > peak) peak = magnitude;
      }
    }
    this.previous = c;
    this.current = n;
    this.next = p;
    this.lastPeak = peak;
    if (drain && --drain.steps <= 0) this.drain = null;
    return peak;
  }

  clear(): void {
    this.current.fill(0);
    this.previous.fill(0);
    this.lastPeak = 0;
    this.drain = null;
  }
}

// The rain keeps about this share of columns falling, each drop 11–31 cells a
// second with a trail of 7–27 cells. A head the water knocks further than
// RAIN_BREAK from its rest breaks the drop.
const RAIN_DENSITY = 0.3;
const RAIN_BREAK = 0.2;

interface RainDrop {
  /** Row of the head, in cells from the top (fractional). */
  y: number;
  speed: number;
  length: number;
  fade: number;
  broken: boolean;
}

/**
 * The loading rain: drops run down the sheet's columns, a lit head and a trail
 * that fades behind it, lighting each cell's own character as they pass. A
 * column holds at most two drops. A drop whose head the water knocks breaks
 * and fades, and its column lets a new one fall from the top a moment later,
 * so the rain comes back by itself. Stopped, no new drops fall and those out
 * fade in about half a second.
 */
export class CharSeaRain {
  /** Per cell, row by row: how lit its trail is, then whether a head is on it (0..255 each). */
  readonly cells: Uint8Array;
  private columns: { drops: RainDrop[]; wait: number }[] = [];
  private falling = false;
  private level = 0;

  constructor(
    readonly cols: number,
    readonly rows: number,
    private readonly random: () => number = Math.random,
  ) {
    this.cells = new Uint8Array(cols * rows * 2);
  }

  get raining(): boolean {
    return this.falling;
  }

  private life(): number {
    return (this.rows + 17) / 21;
  }

  private gap(): number {
    return (this.life() * (1 - RAIN_DENSITY)) / RAIN_DENSITY;
  }

  /** Begins: about the density's share of columns start within 0.9s, the rest later. */
  start(): void {
    if (this.falling) return;
    this.falling = true;
    this.columns = Array.from({ length: this.cols }, () => ({
      drops: [],
      wait: this.random() < RAIN_DENSITY ? this.random() * 0.9 : this.random() * this.gap(),
    }));
  }

  stop(): void {
    this.falling = false;
  }

  /**
   * Moves the rain on by `dt` seconds and lights `cells`. `offRest(col, row)`
   * is how far the water under a head stands from its rest. Returns whether
   * anything is still falling or lit.
   */
  tick(dt: number, offRest: (col: number, row: number) => number): boolean {
    this.level += ((this.falling ? 1 : 0) - this.level) * (1 - Math.exp(-dt / (this.falling ? 0.05 : 0.1)));
    this.cells.fill(0);
    if (!this.falling && this.level < 0.01) {
      // faded out: the drops still out go with it
      this.level = 0;
      this.columns = [];
      return false;
    }
    let lit = false;
    this.columns.forEach((column, col) => {
      column.wait -= dt;
      const lastDrop = column.drops[column.drops.length - 1];
      if (this.falling && column.wait <= 0 && column.drops.length < 2 && (!lastDrop || lastDrop.y - lastDrop.length > 2)) {
        column.drops.push({
          y: -this.random() * 4,
          speed: 11 + this.random() * 20,
          length: 7 + this.random() * 20,
          fade: 1,
          broken: false,
        });
        column.wait = this.gap() * (0.3 + this.random() * 1.4);
      }
      for (let k = column.drops.length - 1; k >= 0; k -= 1) {
        const drop = column.drops[k];
        drop.y += drop.speed * dt;
        if (!drop.broken && Math.abs(offRest(col, drop.y)) > RAIN_BREAK) {
          drop.broken = true;
          column.wait = Math.min(column.wait, 0.25 + this.random() * 0.9);
        }
        if (drop.broken) drop.fade -= dt * 4;
        if (drop.fade <= 0 || drop.y - drop.length > this.rows) {
          column.drops.splice(k, 1);
          continue;
        }
        lit = true;
        const head = Math.floor(drop.y);
        const strength = drop.fade * this.level;
        for (let row = Math.max(0, head - Math.ceil(drop.length)); row <= Math.min(this.rows - 1, head); row += 1) {
          const trail = Math.max(0, 1 - (drop.y - row) / drop.length);
          const at = (row * this.cols + col) * 2;
          this.cells[at] = Math.max(this.cells[at], Math.round(255 * strength * trail ** 1.25));
          if (row === head) this.cells[at + 1] = Math.max(this.cells[at + 1], Math.round(255 * strength));
        }
      }
    });
    return lit || this.falling;
  }
}

/**
 * Which of the sheet's cells a water-grid shape covers (more than `threshold`
 * of it under the cell's centre), row by row: the cells of the loading word.
 */
export function charSeaCellsCovered(
  layout: CharSeaLayout,
  shape: Float32Array,
  waterCols: number,
  waterRows: number,
  threshold = 0.35,
): Uint8Array {
  const cells = new Uint8Array(layout.cols * layout.rows);
  for (let row = 0; row < layout.rows; row += 1) {
    for (let col = 0; col < layout.cols; col += 1) {
      const x = Math.floor((layout.originX + (col + 0.5) * layout.cellWidth) / CHAR_SEA_WATER_CELL);
      const y = Math.floor((layout.originY + (row + 0.5) * layout.cellHeight) / CHAR_SEA_WATER_CELL);
      if (x >= 0 && y >= 0 && x < waterCols && y < waterRows && shape[y * waterCols + x] > threshold) {
        cells[row * layout.cols + col] = 1;
      }
    }
  }
  return cells;
}

// Changes a second per cell while it loads: under a rain head, in a rain
// trail, and in a cell of the loading word.
const SWAP_HEAD = 14;
const SWAP_TRAIL = 2.5;
const SWAP_WORD = 0.8;
const SWAP_SEA = 1;
const LETTER = /[\p{L}\p{N}]/u;

/**
 * The characters drawn in the sheet's cells. While the sea moves, every cell
 * now and then (about once a second) trades its own character for another
 * letter of the same passage (never punctuation), so the sea never stands
 * still as one text. Under the rain and in the loading word they change as
 * digital rain's do on top of that: a head swaps its cell's character many
 * times a second, a trail now and then, a cell of the word about once a second.
 * A cell the rain and the word have left shows its own character again.
 */
export class CharSeaGlyphs {
  /** The glyph drawn in each cell, row by row (indices into the layout's glyphs). */
  readonly live: Uint8Array;
  /** Each cell's own character, which drifts slowly through the passage's letters. */
  readonly own: Uint8Array;
  private readonly letters: number[];

  constructor(layout: CharSeaLayout, private readonly random: () => number = Math.random) {
    this.own = layout.map.slice();
    this.live = layout.map.slice();
    this.letters = layout.glyphs.flatMap((glyph, index) => (LETTER.test(glyph) ? [index] : []));
  }

  /**
   * Moves on by `dt` seconds. `rain` is `CharSeaRain.cells` (null: no rain),
   * `word` the loading word's cells (null: no word). Returns whether any cell
   * is still changing, and whether `live` changed.
   */
  tick(dt: number, rain: Uint8Array | null, word: Uint8Array | null): { changing: boolean; changed: boolean } {
    let changing = false;
    let changed = false;
    // The slow drift of the cells' own characters. It only runs while the sea
    // is drawn for something else, so on its own it never keeps the sea awake.
    if (this.letters.length) {
      const expected = this.own.length * SWAP_SEA * dt;
      const count = Math.floor(expected) + (this.random() < expected % 1 ? 1 : 0);
      for (let k = 0; k < count; k += 1) {
        this.own[Math.floor(this.random() * this.own.length)] = this.letters[Math.floor(this.random() * this.letters.length)];
      }
    }
    for (let i = 0; i < this.live.length; i += 1) {
      let rate = 0;
      if (rain) rate = rain[i * 2 + 1] > 40 ? SWAP_HEAD : rain[i * 2] > 20 ? SWAP_TRAIL : 0;
      if (word && word[i]) rate = Math.max(rate, SWAP_WORD);
      if (rate && this.letters.length) {
        changing = true;
        if (this.random() < rate * dt) {
          this.live[i] = this.letters[Math.floor(this.random() * this.letters.length)];
          changed = true;
        }
      } else if (this.live[i] !== this.own[i]) {
        this.live[i] = this.own[i];
        changed = true;
      }
    }
    return { changing, changed };
  }
}
