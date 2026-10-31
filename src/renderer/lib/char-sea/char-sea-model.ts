import type { CharSeaLanguage } from './char-sea-text';

/**
 * The two halves of the sea that need no GPU: where each character sits, and
 * the water under them.
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
        const value = (2 * c[i] - p[i] + C2 * laplacian) * d[i] * calm;
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
