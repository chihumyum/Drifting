/**
 * Which cover style the shelf shows, kept on this device. The shelf's round
 * button turns to the next style; every cover follows at once.
 */
import { DEFAULT_COVER_STYLE, isCoverStyle, nextCoverStyle, type CoverStyleId } from './styles';

const STYLE_KEY = 'shelf:cover-style';
let current: CoverStyleId | null = null;
const listeners = new Set<() => void>();

export function readCoverStyle(): CoverStyleId {
  if (current) return current;
  try {
    const stored = localStorage.getItem(STYLE_KEY);
    current = isCoverStyle(stored) ? stored : DEFAULT_COVER_STYLE;
  } catch {
    current = DEFAULT_COVER_STYLE;
  }
  return current;
}

export function storeCoverStyle(style: CoverStyleId) {
  current = style;
  try {
    localStorage.setItem(STYLE_KEY, style);
  } catch {
    /* private mode or quota: the style just isn't remembered */
  }
  for (const listener of listeners) listener();
}

export function turnCoverStyle(): CoverStyleId {
  const next = nextCoverStyle(readCoverStyle());
  storeCoverStyle(next);
  return next;
}

export function subscribeCoverStyle(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
