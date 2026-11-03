/**
 * The TODO and comment rails of TODO & Materials: each is dragged wider by
 * its right edge and remembered on this machine. A rail never gets narrower
 * than one card, and never so wide that the library beside it drops below
 * its own minimum; inside, the cards flow into as many columns as fit.
 */
export type SmmRail = 'todo' | 'comment';

export type SmmRailWidths = Record<SmmRail, number>;

export const SMM_RAIL_MIN = 240;
export const SMM_LIBRARY_MIN = 360;
export const SMM_RAIL_DEFAULTS: SmmRailWidths = { todo: 280, comment: 280 };
/** How far one arrow key moves a focused edge. */
export const SMM_RAIL_KEY_STEP = 24;

const WIDTHS_KEY = 'super-memo-material:rail-widths';

/**
 * The width a rail takes when its edge moves by `delta` from `start`, given
 * `room`: what the split has left once the other rail and the library's
 * minimum are subtracted.
 */
export function dragRailWidth(start: number, delta: number, room: number): number {
  const max = Math.max(SMM_RAIL_MIN, room);
  return Math.round(Math.min(max, Math.max(SMM_RAIL_MIN, start + delta)));
}

function storedWidth(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(SMM_RAIL_MIN, Math.round(value))
    : fallback;
}

export function readRailWidths(): SmmRailWidths {
  try {
    const stored = JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? 'null') as Partial<Record<SmmRail, unknown>> | null;
    if (!stored || typeof stored !== 'object') return { ...SMM_RAIL_DEFAULTS };
    return {
      todo: storedWidth(stored.todo, SMM_RAIL_DEFAULTS.todo),
      comment: storedWidth(stored.comment, SMM_RAIL_DEFAULTS.comment),
    };
  } catch {
    return { ...SMM_RAIL_DEFAULTS };
  }
}

export function storeRailWidths(widths: SmmRailWidths) {
  try {
    localStorage.setItem(WIDTHS_KEY, JSON.stringify(widths));
  } catch {
    /* private mode or quota: the widths just aren't remembered */
  }
}
