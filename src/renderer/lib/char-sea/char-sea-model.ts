import type { CharSeaLanguage } from './char-sea-text';

/**
 * The parts of the sea that need no GPU: where each character sits, the water
 * under them (and a shape it can be held to), and the loading rain.
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
   * shape spreads as rings. The spring's target is compensated with the same
   * Laplacian and damping `step` uses, so at rest the water stands exactly at
   * shape × height, and whatever knocks it settles back.
   */
  hold(shape: Float32Array | null): void {
    if (!shape) {
      this.held = null;
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
        n[i] = value;
        const magnitude = value < 0 ? -value : value;
        if (magnitude > peak) peak = magnitude;
      }
    }
    this.previous = c;
    this.current = n;
    this.next = p;
    this.lastPeak = peak;
    return peak;
  }

  clear(): void {
    this.current.fill(0);
    this.previous.fill(0);
    this.lastPeak = 0;
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
