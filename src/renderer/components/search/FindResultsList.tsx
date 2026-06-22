import { useEffect, useRef } from 'react';

// One result row: a one-line context snippet with the matched substring marked,
// plus the index of the underlying match (so the owner can navigate/highlight)
// and an optional group it belongs to.
export interface FindResultRow {
  // Index into the owner panel's match array — passed back on click.
  index: number;
  // Rows sharing a groupKey render under one header (e.g. a chapter). Ignored
  // when showGroups is false.
  groupKey: string;
  groupLabel: string;
  // Context snippet + where the hit sits inside it (for the <mark>).
  excerpt: string;
  matchStart: number;
  matchEnd: number;
}

interface FindResultsListProps {
  rows: FindResultRow[];
  // The currently-focused match index (owner's coordinate space) — the matching
  // row is emphasised and scrolled into view.
  activeIndex: number;
  onPick: (index: number) => void;
  // Render group headers (whole-book search). Single-document search leaves this
  // off and shows a flat list.
  showGroups?: boolean;
  // Total match count, for the "showing first N" footer when capped.
  totalCount: number;
}

// How many rows we actually render. A short query in a long book can match tens
// of thousands of times; rendering them all would jank. The find bar still steps
// through every match via Enter — only the visual list is capped.
const MAX_ROWS = 500;

// Split a snippet into before / hit / after so the hit can be wrapped in a
// <mark>. Defensive clamping keeps it safe if offsets ever drift.
function renderExcerpt(text: string, start: number, end: number) {
  const s = Math.max(0, Math.min(start, text.length));
  const e = Math.max(s, Math.min(end, text.length));
  return (
    <>
      {text.slice(0, s)}
      <mark className="find-list-mark">{text.slice(s, e)}</mark>
      {text.slice(e)}
    </>
  );
}

// Shared results dropdown for both the whole-book find (通览全书) and the
// single-editor find. Each row shows a one-line context excerpt; clicking it
// jumps to (and highlights) that match.
export function FindResultsList({
  rows,
  activeIndex,
  onPick,
  showGroups = false,
  totalCount,
}: FindResultsListProps) {
  const activeRef = useRef<HTMLButtonElement>(null);

  // Keep the focused row visible as the user steps through matches.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (rows.length === 0) return null;

  const shown = rows.slice(0, MAX_ROWS);

  return (
    <div className="find-list" role="listbox">
      {shown.map((row, i) => {
        // First row of a new group gets a header — derived positionally so no
        // mutable render-time state is needed.
        const isFirstOfGroup = showGroups && (i === 0 || shown[i - 1].groupKey !== row.groupKey);
        const isActive = row.index === activeIndex;
        return (
          <div key={`wrap-${row.index}`}>
            {isFirstOfGroup && (
              <div className="find-list-group" title={row.groupLabel}>
                {row.groupLabel || '—'}
              </div>
            )}
            <button
              type="button"
              ref={isActive ? activeRef : undefined}
              className={`find-list-row${isActive ? ' is-active' : ''}`}
              onClick={() => onPick(row.index)}
              role="option"
              aria-selected={isActive}
            >
              <span className="find-list-excerpt">
                {renderExcerpt(row.excerpt, row.matchStart, row.matchEnd)}
              </span>
            </button>
          </div>
        );
      })}
      {totalCount > MAX_ROWS && (
        <div className="find-list-more">仅显示前 {MAX_ROWS} 条 · 共 {totalCount} 条</div>
      )}
    </div>
  );
}
