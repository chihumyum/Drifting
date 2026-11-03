/**
 * Who is using the sea of characters right now. A full-window wait holds it
 * as loading (rain falls and "Loading" rises), a first run holds it as a title
 * (rain falls and the app's name rises at once), a page that lies on it holds
 * it as a surface (it stays on, still until touched), a page that lies on it
 * waiting for the author holds it as rain (rain falls round the page, no
 * word), and glass on that page is registered as a shape so the sea can draw
 * its rim. The sea is on while anything holds it.
 */

/** The name a first run raises from the sea, in the loading word's face and size. */
export const CHAR_SEA_TITLE = 'Drifting';

export interface CharSeaShapeOptions {
  /** Strength of the resting line (the app's resting glass is 0.85; 0: only what the water brings). */
  rest: number;
  radius: number;
  /** Set down on the sea: the resting line starts from nothing and settles in. */
  arrive?: boolean;
}

export interface CharSeaShapeEntry {
  id: number;
  element: HTMLElement;
  options: CharSeaShapeOptions;
  hover: boolean;
  /** Waiting on the author (the sample book until it is opened): the rim flows as under the pointer. */
  waiting: boolean;
}

export interface CharSeaHolds {
  loading: number;
  title: number;
  rain: number;
  surfaces: number;
}

export type CharSeaHoldKind = 'loading' | 'title' | 'rain' | 'surface';

/**
 * A page handing the sea to the next (the shelf to the wait for the book it
 * opened, one wait to the next) lets go and takes hold in the same commit, or
 * a moment later. A wait that ends counts only after this, so its rain and
 * word carry on.
 */
export const CHAR_SEA_HANDOVER_MS = 80;

let holds: CharSeaHolds = { loading: 0, title: 0, rain: 0, surfaces: 0 };
// When the current run of loading holds began (handovers do not break it).
let loadingSince: number | null = null;
let loadingLetGoAt = 0;
let nextId = 1;
const shapes = new Map<number, CharSeaShapeEntry>();
const holdListeners = new Set<() => void>();
const shapeListeners = new Set<() => void>();
const dropListeners = new Set<(x: number, y: number, amplitude: number) => void>();

function setHolds(next: CharSeaHolds): void {
  const now = performance.now();
  if (next.loading > 0 && holds.loading === 0 && (loadingSince === null || now - loadingLetGoAt > CHAR_SEA_HANDOVER_MS)) {
    loadingSince = now;
  }
  if (next.loading === 0 && holds.loading > 0) loadingLetGoAt = now;
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
  /** When the wait now holding the sea began (performance.now()), or null if none does. */
  loadingSince(): number | null {
    return holds.loading > 0 ? loadingSince : null;
  },
  /** Holds the sea on; the returned function lets go. */
  hold(kind: CharSeaHoldKind): () => void {
    const key = kind === 'surface' ? 'surfaces' : kind;
    setHolds({ ...holds, [key]: holds[key] + 1 });
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      setHolds({ ...holds, [key]: Math.max(0, holds[key] - 1) });
    };
  },
  /** Registers glass the sea draws; the returned function takes it off again. */
  addShape(element: HTMLElement, options: CharSeaShapeOptions, waiting = false): () => void {
    const entry: CharSeaShapeEntry = { id: nextId++, element, options, hover: false, waiting };
    shapes.set(entry.id, entry);
    shapesChanged();
    return () => {
      if (shapes.delete(entry.id)) shapesChanged();
    };
  },
  /** Registered glass changed size on its own (not by scrolling or the window): it is measured again. */
  resized(): void {
    shapesChanged();
  },
  /** The pointer or focus came onto, or left, a registered piece of glass. */
  hover(element: HTMLElement, on: boolean): void {
    for (const entry of shapes.values()) {
      if (entry.element !== element || entry.hover === on) continue;
      entry.hover = on;
      shapesChanged();
    }
  },
  /**
   * A registered piece of glass changed in place: its resting line's strength
   * (the sea eases to it) or whether it waits on the author.
   */
  update(element: HTMLElement, change: { rest: number; waiting: boolean }): void {
    for (const entry of shapes.values()) {
      if (entry.element !== element) continue;
      if (entry.options.rest === change.rest && entry.waiting === change.waiting) continue;
      entry.options = { ...entry.options, rest: change.rest };
      entry.waiting = change.waiting;
      shapesChanged();
    }
  },
  /** One ring from (x, y) in the window, as a press makes; only a live sea takes it. */
  drop(x: number, y: number, amplitude = 1.2): void {
    dropListeners.forEach((listener) => listener(x, y, amplitude));
  },
  onDrop(listener: (x: number, y: number, amplitude: number) => void): () => void {
    dropListeners.add(listener);
    return () => dropListeners.delete(listener);
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
};
