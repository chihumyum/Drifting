import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { isChapter, type BookNode } from '../../domain/book-node';
import type { Storyline } from '../../domain/storyline';
import { CELL_H, BAND_PILL_PX, BAND_SLOT_PX, BAND_PAD_PX } from './super-element-metrics';

/**
 * Read-only storyline band rendered in the middle of the canvas. Lifted from
 * BottomTimeline's mental model but pared down: no drag, no click-to-open,
 * no narrative-axis pins. Only the cross-storyline dashed transit + node
 * pills with hover summary, per design decision 1.
 *
 * The band's height in cells is `storylines.length + 1`: one row per
 * storyline plus a thin top axis. Drift nodes are not shown here — they
 * surface via the optional drift panel.
 */
export interface ChapterBandProps {
  storylines: Storyline[];
  nodes: BookNode[];
  nodeStorylineMapping: Record<string, string[]>;
  /** Map from nodeId to its primary storyline id (null = "未归属"). */
  primaryStorylineByNode: Record<string, string | null>;
  /** Cell-coordinate origin: gridX=0, gridY=0 corresponds to band top-left. */
  bandWidthCells: number;
  bandHeightCells: number;
  onNodeClick: (node: BookNode, anchor: DOMRect, opts: { shiftKey: boolean }) => void;
  linkSourceNodeId?: string | null;
}

function ChapterBand({
  storylines,
  nodes,
  nodeStorylineMapping,
  primaryStorylineByNode,
  bandWidthCells,
  bandHeightCells,
  onNodeClick,
  linkSourceNodeId,
}: ChapterBandProps) {
  const { t } = useTranslation();
  const placedNodes = useMemo(() => nodes.filter(isChapter), [nodes]);

  const storylineById = useMemo(() => new Map(storylines.map((s) => [s.id, s])), [storylines]);
  const rowIndexByStoryline = useMemo(() => {
    const m = new Map<string, number>();
    storylines.forEach((s, i) => m.set(s.id, i));
    return m;
  }, [storylines]);

  // Position chapters by their SEQUENTIAL INDEX in book order — packs them
  // tight regardless of gaps in bookOrder values, so the band length
  // scales with chapter count rather than the raw bookOrder range. Pills
  // themselves are fixed-width (BAND_PILL_PX) so they stay readable at
  // any density.
  const sortedPlacedNodes = useMemo(
    () => placedNodes.slice().sort((a, b) => a.bookOrder - b.bookOrder),
    [placedNodes],
  );
  const slotIndexByNodeId = useMemo(() => {
    const m = new Map<string, number>();
    sortedPlacedNodes.forEach((n, i) => m.set(n.id, i));
    return m;
  }, [sortedPlacedNodes]);

  // Cross-storyline transit lines: a node that belongs to multiple
  // storylines surfaces a dashed connector from the previous to next node
  // on each non-main storyline lane. Coordinates use the slot index above.
  const sortedByStoryline = useMemo(() => {
    const m = new Map<string, BookNode[]>();
    storylines.forEach((s) => m.set(s.id, []));
    sortedPlacedNodes.forEach((n) => {
      const ids = nodeStorylineMapping[n.id] || [];
      ids.forEach((sId) => {
        const arr = m.get(sId);
        if (arr) arr.push(n);
      });
    });
    return m;
  }, [storylines, sortedPlacedNodes, nodeStorylineMapping]);

  const slotCenterX = (idx: number): number => idx * BAND_SLOT_PX + BAND_PILL_PX / 2;

  const transits = useMemo(() => {
    type Transit = { key: string; x1: number; y1: number; x2: number; y2: number; color: string };
    const out: Transit[] = [];
    for (const sl of storylines) {
      const lane = sortedByStoryline.get(sl.id) ?? [];
      for (let i = 0; i < lane.length - 1; i++) {
        const a = lane[i];
        const b = lane[i + 1];
        const primaryA = primaryStorylineByNode[a.id] ?? null;
        const primaryB = primaryStorylineByNode[b.id] ?? null;
        if (primaryA === sl.id && primaryB === sl.id) continue;
        const rowA = rowIndexByStoryline.get(primaryA ?? '');
        const rowB = rowIndexByStoryline.get(primaryB ?? '');
        const idxA = slotIndexByNodeId.get(a.id);
        const idxB = slotIndexByNodeId.get(b.id);
        if (rowA === undefined || rowB === undefined) continue;
        if (idxA === undefined || idxB === undefined) continue;
        out.push({
          key: `${sl.id}:${a.id}->${b.id}`,
          x1: slotCenterX(idxA),
          y1: BAND_PAD_PX + rowA * CELL_H + CELL_H / 2,
          x2: slotCenterX(idxB),
          y2: BAND_PAD_PX + rowB * CELL_H + CELL_H / 2,
          color: sl.color || 'hsl(var(--ink-4))',
        });
      }
    }
    return out;
  }, [
    storylines,
    sortedByStoryline,
    rowIndexByStoryline,
    slotIndexByNodeId,
    primaryStorylineByNode,
  ]);

  // Band fits exactly N slots wide. Caller passes bandWidthCells purely for
  // the empty/legend states; the actual pixel width is derived from the
  // slot count.
  const bandPxWidth =
    sortedPlacedNodes.length > 0
      ? sortedPlacedNodes.length * BAND_SLOT_PX
      : bandWidthCells * BAND_SLOT_PX;
  const bandPxHeight = bandHeightCells * CELL_H;

  if (storylines.length === 0) {
    return (
      <div
        style={{
          width: bandPxWidth,
          height: bandPxHeight,
          background: 'hsl(var(--paper-deep))',
          border: '1px dashed hsl(var(--rule))',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          color: 'hsl(var(--ink-4))',
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
        }}
      >
        {t('superElement.empty.noStorylines')}
      </div>
    );
  }

  return (
    <div
      style={{
        position: 'relative',
        width: bandPxWidth,
        height: bandPxHeight,
        background: 'hsl(var(--paper-deep) / 0.65)',
        borderTop: '1px solid hsl(var(--rule))',
        borderBottom: '1px solid hsl(var(--rule))',
        overflow: 'hidden',
      }}
    >
      {/* Storyline lane backgrounds (thin tint behind each row). The band
          no longer carries an axis row — the storyline labels alone suffice
          for context, and dropping the axis tightens the iceberg's middle.
          A small BAND_PAD_PX of empty top/bottom space keeps storyline rows
          from touching the categories above/below the band. */}
      {storylines.map((s, idx) => (
        <div
          key={`lane-${s.id}`}
          style={{
            position: 'absolute',
            left: 0,
            top: BAND_PAD_PX + idx * CELL_H,
            width: bandPxWidth,
            height: CELL_H,
            borderTop: idx === 0 ? 'none' : '1px dotted hsl(var(--rule) / 0.4)',
            borderBottom:
              idx === storylines.length - 1 ? 'none' : '1px dotted hsl(var(--rule) / 0.4)',
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: 8,
              top: '50%',
              transform: 'translateY(-50%)',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontFamily: 'var(--font-mono)',
              fontSize: 9,
              color: 'hsl(var(--ink-3))',
              letterSpacing: '0.08em',
              maxWidth: 110,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
            }}
          >
            <span
              aria-hidden
              style={{
                width: 6,
                height: 6,
                borderRadius: 2,
                background: s.color || 'hsl(var(--ink-4))',
                flexShrink: 0,
              }}
            />
            <span>{s.name || 'untitled'}</span>
          </div>
        </div>
      ))}

      {/* Cross-storyline transit dashed lines. */}
      <svg
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
        }}
      >
        {transits.map((t) => (
          <line
            key={t.key}
            x1={t.x1}
            y1={t.y1}
            x2={t.x2}
            y2={t.y2}
            stroke={t.color}
            strokeWidth={1}
            strokeDasharray="3 3"
            opacity={0.55}
          />
        ))}
      </svg>

      {/* Node pills. Mirror StoryGraphView's tile pattern: title on top, summary
          as a 2-line clamp underneath when present. Hover title attribute
          stays as a fallback so the full text is still inspectable when the
          clamp truncates. Shift-click marks the pill as a link source for
          cross-band relations. */}
      {sortedPlacedNodes.map((node, idx) => {
        const primaryId = primaryStorylineByNode[node.id] ?? null;
        const rowIdx = rowIndexByStoryline.get(primaryId ?? '');
        if (rowIdx === undefined) return null;
        const sl = primaryId ? storylineById.get(primaryId) : undefined;
        const color = sl?.color || 'hsl(var(--ink-4))';
        const x = idx * BAND_SLOT_PX;
        // Pill mirrors element cards (CELL_H - 6 tall, 3px top inset). The
        // vertical centre still lands on row centre so edge endpoints
        // computed in the parent (CELL_H/2 offset) line up unchanged.
        const y = BAND_PAD_PX + rowIdx * CELL_H + 3;
        const isLinkSource = linkSourceNodeId === node.id;
        return (
          <div
            key={node.id}
            data-super-card="node"
            data-node-id={node.id}
            title={
              node.summary
                ? `${node.title || t('common.untitled')}\n\n${node.summary}`
                : node.title || t('common.untitled')
            }
            onClick={(e) => {
              e.stopPropagation();
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              onNodeClick(node, rect, { shiftKey: e.shiftKey });
            }}
            style={{
              position: 'absolute',
              left: x,
              top: y,
              width: BAND_PILL_PX,
              height: CELL_H - 6,
              borderRadius: 3,
              background: isLinkSource
                ? 'hsl(var(--paper-deep))'
                : `color-mix(in srgb, ${color} 6%, hsl(var(--paper)))`,
              border: `1px solid ${color}`,
              boxShadow: 'none',
              outline: isLinkSource ? `2px dashed ${color}` : 'none',
              outlineOffset: isLinkSource ? '1px' : 0,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: node.summary ? 'flex-start' : 'center',
              gap: 2,
              padding: '4px 7px',
              overflow: 'hidden',
              // Inherit viewport's grab cursor — plain click is a no-op
              // (chapters are read-only), but the user can drag from here
              // to pan the canvas. shift-click still pairs for linking.
              cursor: 'inherit',
            }}
          >
            <div
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: 11,
                lineHeight: 1.15,
                color: 'hsl(var(--ink-1))',
                fontWeight: 500,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              {node.title || t('common.untitled')}
            </div>
            {node.summary && (
              <div
                style={{
                  fontSize: 9,
                  lineHeight: 1.25,
                  color: 'hsl(var(--ink-4))',
                  overflow: 'hidden',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  flex: 1,
                }}
              >
                {node.summary}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export const SuperElementChapterBand = memo(ChapterBand);
