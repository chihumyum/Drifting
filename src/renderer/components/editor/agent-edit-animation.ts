import type { AgentBlockChange, DiffSeg } from '../../lib/agent/block-diff';
import type { CSSProperties } from 'react';

export interface AgentEditRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function cssColorAlpha(color: string): number {
  const normalized = color.trim().toLowerCase();
  if (!normalized || normalized === 'transparent') return 0;

  // Modern computed colors may use a slash (`rgb(0 0 0 / 0.5)`), while older
  // WebKit returns legacy comma-separated rgba(). Values without an explicit
  // alpha channel are opaque.
  const slashAlpha = normalized.match(/\/\s*([\d.]+)%?\s*\)$/);
  if (slashAlpha) {
    const value = Number(slashAlpha[1]);
    return slashAlpha[0].includes('%') ? value / 100 : value;
  }
  const legacy = normalized.match(/^rgba?\((.*)\)$/);
  if (legacy) {
    const parts = legacy[1].split(',').map((part) => part.trim());
    if (parts.length === 4) {
      const value = Number.parseFloat(parts[3]);
      return Number.isFinite(value) ? value : 1;
    }
  }
  return 1;
}

/**
 * Pick a genuinely opaque backdrop for a reveal overlay. Editor surfaces are
 * allowed to be transparent (for example the flat continuous-page treatment),
 * but using that transparent value on the overlay exposes the already-written
 * live prose underneath and makes the typewriter look like a duplicate pass.
 */
export function agentEditOpaqueBackground(
  candidates: readonly string[],
  fallback = '#fff',
): string {
  return candidates.find((color) => cssColorAlpha(color) >= 0.999) ?? fallback;
}

/** The overlay uses the anchor's measured border box, but lives outside its
 * prose ancestors. Copy the resolved text layout instead of inheriting the UI
 * defaults: equal outer widths alone do not produce equal line breaks. */
export function agentEditProseStyle(style: CSSStyleDeclaration): CSSProperties {
  return {
    boxSizing: 'border-box',
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    fontStyle: style.fontStyle,
    fontStretch: style.fontStretch,
    fontVariant: style.fontVariant,
    fontFeatureSettings: style.fontFeatureSettings,
    fontVariationSettings: style.fontVariationSettings,
    fontKerning: style.fontKerning as CSSProperties['fontKerning'],
    lineHeight: style.lineHeight,
    letterSpacing: style.letterSpacing,
    wordSpacing: style.wordSpacing,
    color: style.color,
    textAlign: style.textAlign as CSSProperties['textAlign'],
    textAlignLast: style.textAlignLast as CSSProperties['textAlignLast'],
    textIndent: style.textIndent,
    textTransform: style.textTransform as CSSProperties['textTransform'],
    textWrap: style.textWrap as CSSProperties['textWrap'],
    whiteSpace: style.whiteSpace as CSSProperties['whiteSpace'],
    wordBreak: style.wordBreak as CSSProperties['wordBreak'],
    overflowWrap: style.overflowWrap as CSSProperties['overflowWrap'],
    lineBreak: style.lineBreak as CSSProperties['lineBreak'],
    hyphens: style.hyphens as CSSProperties['hyphens'],
    direction: style.direction as CSSProperties['direction'],
    tabSize: style.tabSize,
    paddingTop: style.paddingTop,
    paddingBottom: style.paddingBottom,
    paddingLeft: style.paddingLeft,
    paddingRight: style.paddingRight,
    borderTop: style.borderTop,
    borderBottom: style.borderBottom,
    borderLeft: style.borderLeft,
    borderRight: style.borderRight,
  };
}

/** Measure the text boundary without putting a caret between text runs: even
 * an absolute inline caret there can interrupt ligatures and change shaping.
 * `atEnd` measures the boundary run's end (a caret after the last character). */
export function placeAgentRevealCaret(caret: HTMLElement, boundary: HTMLElement, atEnd = false) {
  const host = caret.offsetParent;
  if (!(host instanceof HTMLElement)) return;
  const range = document.createRange();
  range.selectNodeContents(boundary);
  range.collapse(!atEnd);
  const rect = range.getBoundingClientRect();
  const base = host.getBoundingClientRect();
  Object.assign(caret.style, {
    left: `${rect.left - base.left - host.clientLeft + host.scrollLeft}px`,
    top: `${rect.top - base.top - host.clientTop + host.scrollTop}px`,
    height: `${rect.height}px`,
    visibility: rect.height ? 'visible' : 'hidden',
  });
}

/**
 * Convert an anchor's viewport rect into the coordinate space of the scrolling
 * overlay host. Both the prose anchor and a nested host move in the same native
 * scroll transaction, so the returned coordinates stay stable while scrolling.
 * `scrollTop` / `scrollLeft` keep the fallback correct when the host is the
 * scroll container itself rather than its in-flow `.editor__spread` child.
 */
export function agentEditRectInScrollHost(
  anchor: AgentEditRect,
  host: Pick<AgentEditRect, 'top' | 'left'>,
  scrollTop = 0,
  scrollLeft = 0,
  clientTop = 0,
  clientLeft = 0,
): AgentEditRect {
  return {
    top: anchor.top - host.top + scrollTop - clientTop,
    left: anchor.left - host.left + scrollLeft - clientLeft,
    width: anchor.width,
    height: anchor.height,
  };
}

/** Stable per-review identity so two accepted batches touching one block both animate. */
export function agentEditAnimationKey(change: AgentBlockChange): string {
  return `${change.reviewId ?? 'legacy'}:${change.op}:${change.blockId}`;
}

/** Count one editor's pending/playing prose reveals, including offscreen ones.
 * A commit can coexist with its pending projection, and a rejection can change
 * op, so deduplicate by review + block rather than overlay key. */
export function agentEditRevealCount(...groups: Iterable<AgentBlockChange>[]): number {
  const keys = new Set<string>();
  for (const changes of groups) {
    for (const change of changes) {
      if (!change.field) keys.add(`${change.reviewId ?? 'legacy'}:${change.blockId}`);
    }
  }
  return keys.size;
}

/** Apply the author's paragraph-count tiers to the original character-based
 * pacing. Sample once per overlay so siblings
 * finishing cannot restart or slow down a reveal already in flight. */
export function agentEditRevealTiming(changedCharacters: number, revealCount: number) {
  const speed = revealCount <= 3 ? 0.8
    : revealCount <= 8 ? 1
    : revealCount <= 16 ? 1.5
    : revealCount <= 24 ? 2
    : revealCount <= 48 ? 2.5
    : 3;
  const baseDuration = Math.max(500, Math.min(2500, changedCharacters * 25));
  return {
    durationMs: Math.round(baseDuration / speed),
    exitMs: Math.round(320 / speed),
  };
}

/** Without animation, retain unread marks until the result stays in view for
 * half a second. Scrolling away cancels that dwell; disposal never marks read. */
export function createAgentEditSeenTracker(onSeen: (change: AgentBlockChange) => void) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const seen = new Set<string>();
  return {
    update(visibleChanges: readonly AgentBlockChange[]) {
      const visible = new Set(visibleChanges.map(agentEditAnimationKey));
      for (const [key, timer] of timers) {
        if (!visible.has(key)) {
          clearTimeout(timer);
          timers.delete(key);
        }
      }
      for (const change of visibleChanges) {
        const key = agentEditAnimationKey(change);
        if (seen.has(key) || timers.has(key)) continue;
        timers.set(key, setTimeout(() => {
          timers.delete(key);
          seen.add(key);
          onSeen(change);
        }, 500));
      }
    },
    dispose() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}

/** The visible mutation produced by rejecting an already-applied Agent change. */
export function inverseAgentEditReveal(
  change: AgentBlockChange,
): AgentBlockChange {
  if (change.op === 'new') {
    return {
      ...change,
      op: 'deleted',
      oldText: change.newText,
      newText: '',
    };
  }
  if (change.op === 'deleted') {
    return {
      ...change,
      op: 'new',
      oldText: '',
      newText: change.oldText,
    };
  }
  return {
    ...change,
    oldText: change.newText,
    newText: change.oldText,
  };
}

export function bulkAgentEditRevealChanges(
  changes: readonly AgentBlockChange[],
  decision: 'accepted' | 'reverted',
): AgentBlockChange[] {
  return decision === 'accepted'
    ? [...changes]
    : changes.map(inverseAgentEditReveal);
}

/** A reveal's text as it plays in place: unchanged text, and each place where
 * old words become new ones (`next`). A place that only adds is `new`; one
 * that replaces words is `chg`; one that only deletes has no `next`. */
export type AgentRevealPiece =
  | { kind: 'equal'; text: string }
  | { kind: 'place'; old: string; next: string; mark: 'new' | 'chg' };

export function agentRevealPieces(segments: readonly DiffSeg[]): AgentRevealPiece[] {
  const pieces: AgentRevealPiece[] = [];
  let old = '';
  let next = '';
  const flush = () => {
    if (!old && !next) return;
    pieces.push({ kind: 'place', old, next, mark: old ? 'chg' : 'new' });
    old = '';
    next = '';
  };
  for (const segment of segments) {
    if (segment.kind === 'equal') {
      flush();
      const last = pieces[pieces.length - 1];
      if (last?.kind === 'equal') last.text += segment.text;
      else pieces.push({ kind: 'equal', text: segment.text });
    } else if (segment.kind === 'del') old += segment.text;
    else next += segment.text;
  }
  flush();
  return pieces;
}

const characters = (text: string) => Array.from(text);

/** Steps the in-place reveal takes: each place as many as its longer side. */
export function agentRevealSteps(pieces: readonly AgentRevealPiece[]): number {
  return pieces.reduce((sum, piece) => (piece.kind === 'place'
    ? sum + Math.max(characters(piece.old).length, characters(piece.next).length)
    : sum), 0);
}

export interface AgentRevealRun {
  text: string;
  mark: 'new' | 'chg' | null;
}

/**
 * The paragraph `step` steps into the in-place reveal. The places play one
 * after another, each from its start: when the old words are longer, they are
 * deleted from the front (the text after them closing up) until both sides are
 * as long, then overwritten one character at a time; when they are shorter,
 * they are overwritten first and the rest of the new words is inserted, pushing
 * the text after them on. `caret` is the index of the run the caret stands
 * before (`runs.length` after the last run), or -1 once every place is done.
 */
export function agentRevealFrame(
  pieces: readonly AgentRevealPiece[],
  step: number,
): { runs: AgentRevealRun[]; caret: number } {
  const runs: AgentRevealRun[] = [];
  let caret = -1;
  let left = Math.max(0, Math.floor(step));
  const push = (text: string, mark: AgentRevealRun['mark']) => {
    if (!text) return;
    const last = runs[runs.length - 1];
    if (last && last.mark === mark && caret !== runs.length) last.text += text;
    else runs.push({ text, mark });
  };
  for (const piece of pieces) {
    if (piece.kind === 'equal') { push(piece.text, null); continue; }
    const old = characters(piece.old);
    const next = characters(piece.next);
    const length = Math.max(old.length, next.length);
    if (caret >= 0 || left <= 0) {
      // Not reached yet; the first place not reached holds the caret.
      if (caret < 0) caret = runs.length;
      push(piece.old, null);
      continue;
    }
    if (left >= length) {
      push(piece.next, piece.mark);
      left -= length;
      continue;
    }
    let written: string[];
    let rest: string[];
    if (old.length > next.length) {
      const surplus = old.length - next.length;
      written = left <= surplus ? [] : next.slice(0, left - surplus);
      rest = left <= surplus ? old.slice(left) : old.slice(surplus + written.length);
    } else {
      written = next.slice(0, left);
      rest = left <= old.length ? old.slice(left) : [];
    }
    push(written.join(''), piece.mark);
    caret = runs.length;
    push(rest.join(''), null);
    left = 0;
  }
  return { runs, caret };
}
