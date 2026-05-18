import { useMemo } from 'react';
import type { BookNode } from '../../domain/book-node';
import type { Storyline } from '../../domain/storyline';
import '../../../styles/full-book-lane.css';

interface FullBookLaneProps {
  // Every node that should appear on the global reading line. Drift nodes
  // (without a primary storyline) typically don't belong here — pass them
  // pre-filtered.
  nodes: BookNode[];
  storylines: Storyline[];
  // Resolves a node to the storyline whose color should color its chip.
  // null when the node is unanchored; the lane falls back to ink-4.
  primaryStorylineId: (node: BookNode) => string | null;
  // Active chapter id. The playhead diamond + accent line sit above the
  // chip with this id.
  activeNodeId: string | null;
  // Pixel offset for the sticky rail at the left (RAIL_WIDTH equivalent)
  // so the chips line up with the storyline tracks, not the rails.
  trackOffsetX: number;
  onNodeClick?: (nodeId: string) => void;
  railLabel?: string;
  height?: number;
  chipGap?: number;
}

// Rough chip-width estimator. We need per-chip widths up front so
// `position: absolute` + `transition: left` can smoothly animate reflow;
// flex with `position: static` would size correctly but lose the smooth
// reorder. CJK is treated as ~12px/char, ASCII as ~6.5px/char, plus 14px
// for the color dot and padding. The estimate is intentionally generous
// so the visible title never gets clipped.
function estimateChipWidth(title: string): number {
  let w = 14; // dot + horizontal padding
  for (const ch of title) {
    w += /[　-鿿＀-￯]/.test(ch) ? 12 : 6.5;
  }
  return Math.max(28, Math.ceil(w));
}

// FullBookLane — single-row global reading-order summary. Chips pack
// together from the left (no positional gaps): the user asked for "贴在
// 一起" rather than positioning by raw bookOrder. Each chip shows the
// chapter's full title (no ellipsis); widths derive from title length so
// reordering still animates via CSS `left` transition.
//
// The playhead lives on this lane: positioned by the active chapter's
// index, it's always renderable (bookOrder is non-null for every node),
// unlike the row-level playhead which couldn't render in narrative view
// when narrativeOrder was missing.
export function FullBookLane({
  nodes,
  storylines,
  primaryStorylineId,
  activeNodeId,
  trackOffsetX,
  onNodeClick,
  railLabel = '阅读',
  height = 22,
  chipGap = 4,
}: FullBookLaneProps) {
  const storylineById = useMemo(
    () => new Map(storylines.map((s) => [s.id, s])),
    [storylines],
  );

  // Sort by bookOrder so neighboring chips reflect adjacent chapters.
  // Tie-break on id so equal bookOrder keeps a deterministic visual order.
  const sorted = useMemo(() => {
    return nodes.slice().sort((a, b) => {
      const diff = a.bookOrder - b.bookOrder;
      return diff !== 0 ? diff : a.id.localeCompare(b.id);
    });
  }, [nodes]);

  // Per-chip widths drive the cumulative `left` offsets below. Each chip
  // wraps its full chapter title without truncation, so width depends on
  // the title's character mix (CJK is wider). The math is deliberately
  // computed in render so the layout reflows immediately when titles
  // change (no stale measurements).
  const chipLayout = useMemo(() => {
    const lefts: number[] = [];
    const widths: number[] = [];
    let acc = 0;
    for (const node of sorted) {
      const w = estimateChipWidth(node.title || '未命名');
      lefts.push(acc);
      widths.push(w);
      acc += w + chipGap;
    }
    return { lefts, widths, trackWidth: Math.max(0, acc - chipGap) };
  }, [sorted, chipGap]);

  // Playhead removed — the active chip's own `.is-active` styling carries
  // the "current chapter" signal here; the extra vertical accent line
  // ended up invisible in practice and was just chrome.

  return (
    <div className="fbl" style={{ height, minWidth: trackOffsetX }}>
      {trackOffsetX > 0 && (
        <div className="fbl__rail" style={{ width: trackOffsetX }}>
          <span>{railLabel}</span>
        </div>
      )}
      <div className="fbl__track" style={{ width: chipLayout.trackWidth }}>
        <div className="fbl__line" />
        {sorted.map((node, idx) => {
          const slId = primaryStorylineId(node);
          const color = (slId ? storylineById.get(slId)?.color : null) || 'hsl(var(--ink-4))';
          const isActive = node.id === activeNodeId;
          const isDraft = node.wordCount === 0;
          return (
            <button
              type="button"
              key={node.id}
              className={`fbl__chip${isActive ? ' is-active' : ''}${isDraft ? ' is-draft' : ''}`}
              style={
                {
                  left: chipLayout.lefts[idx],
                  width: chipLayout.widths[idx],
                  ['--chip-color' as string]: color,
                } as React.CSSProperties
              }
              onClick={(e) => {
                e.stopPropagation();
                onNodeClick?.(node.id);
              }}
              title={`§ ${String(node.bookOrder).padStart(2, '0')} · ${node.title || '未命名'}`}
            >
              <span className="fbl__chip-dot" aria-hidden />
              <span className="fbl__chip-title">{node.title || '未命名'}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
