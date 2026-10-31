/**
 * Who is using the sea of characters right now. A full-window wait holds it
 * as loading (drops fall), a page that lies on it holds it as a surface (it
 * stays on, still until touched), and glass on that page is registered as a
 * shape so the sea can draw its rim. The sea is on while anything holds it.
 */

export interface CharSeaShapeOptions {
  /** Strength of the resting line (the app's resting glass is 0.85; 0: only what the water brings). */
  rest: number;
  radius: number;
}

export interface CharSeaShapeEntry {
  id: number;
  element: HTMLElement;
  options: CharSeaShapeOptions;
  hover: boolean;
}

export interface CharSeaHolds {
  loading: number;
  surfaces: number;
}

let holds: CharSeaHolds = { loading: 0, surfaces: 0 };
let nextId = 1;
const shapes = new Map<number, CharSeaShapeEntry>();
const holdListeners = new Set<() => void>();
const shapeListeners = new Set<() => void>();
let press: { x: number; y: number; at: number } | null = null;

function setHolds(next: CharSeaHolds): void {
  holds = next;
  holdListeners.forEach((listener) => listener());
}

function shapesChanged(): void {
  shapeListeners.forEach((listener) => listener());
}

export const charSeaRegistry = {
  subscribe(listener: () => void): () => void {
    holdListeners.add(listener);
    return () => holdListeners.delete(listener);
  },
  getHolds(): CharSeaHolds {
    return holds;
  },
  /** Holds the sea on; the returned function lets go. */
  hold(kind: 'loading' | 'surface'): () => void {
    const key = kind === 'loading' ? 'loading' : 'surfaces';
    setHolds({ ...holds, [key]: holds[key] + 1 });
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      setHolds({ ...holds, [key]: Math.max(0, holds[key] - 1) });
    };
  },
  /** Registers glass the sea draws; the returned function takes it off again. */
  addShape(element: HTMLElement, options: CharSeaShapeOptions): () => void {
    const entry: CharSeaShapeEntry = { id: nextId++, element, options, hover: false };
    shapes.set(entry.id, entry);
    shapesChanged();
    return () => {
      if (shapes.delete(entry.id)) shapesChanged();
    };
  },
  /** The pointer or focus came onto, or left, a registered piece of glass. */
  hover(element: HTMLElement, on: boolean): void {
    for (const entry of shapes.values()) {
      if (entry.element !== element || entry.hover === on) continue;
      entry.hover = on;
      shapesChanged();
    }
  },
  /** Registered glass in document order, as `:nth-of-type` counts it. */
  shapes(): CharSeaShapeEntry[] {
    return [...shapes.values()].sort((a, b) =>
      a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  },
  onShapes(listener: () => void): () => void {
    shapeListeners.add(listener);
    return () => shapeListeners.delete(listener);
  },
  notePress(x: number, y: number): void {
    press = { x, y, at: performance.now() };
  },
  /** The last press on the sea, if it was within `withinMs`. */
  recentPress(withinMs: number): { x: number; y: number; at: number } | null {
    return press && performance.now() - press.at <= withinMs ? press : null;
  },
};
