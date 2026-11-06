import { memo, useMemo, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { isChapter, type BookNode } from '../../domain/book-node';
import type { Storyline } from '../../domain/storyline';
import { KindMark } from '../../components/ui/KindMark';
import { CELL_H, BAND_PILL_PX, BAND_SLOT_PX, BAND_PAD_PX, BAND_RAIL_PX } from './super-element-metrics';

/**
 * Read-only storyline band rendered in the middle of the canvas. Lifted from
 * BottomTimeline's mental model but pared down: no drag, no click-to-open,
 * no narrative-axis pins. Only the cross-storyline dashed transit + node
 * pills with hover summary, per design decision 1.
 *
 * The band's height in cells is `storylines.length + 1`: one row per
 * storyline plus a thin top axis. Drift nodes are not shown here — they
 * surface via the optional drift panel.
 *
 * 砂笔 + 素玻璃 (super-element.css): a small Bottom Timeline. A desk-coloured
 * rail of BAND_RAIL_PX holds the storyline names as sand cells (dash +
 * structure type, a ring under the pointer, a click opens the storyline); the
 * lanes are page-white with a hairline of desk between them; each chapter is
 * a glass slab on the page colour with its storyline's rim, flowing under the
 * pointer and held while it is a relation's source.
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
  /** A storyline name in the rail opens that storyline. */
  onStorylineClick?: (storylineId: string) => void;
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
  onStorylineClick,
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

  // Chapters start after the name rail.
  const railPx = BAND_RAIL_PX;

  const transits = useMemo(() => {
    type Transit = { key: string; x1: number; y1: number; x2: number; y2: number; color: string };
    const out: Transit[] = [];
    const slotCenterX = (idx: number): number => railPx + idx * BAND_SLOT_PX + BAND_PILL_PX / 2;
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
    railPx,
  ]);

  // Band fits exactly N slots wide. Caller passes bandWidthCells purely for
  // the empty/legend states; the actual pixel width is derived from the
  // slot count.
  const bandPxWidth =
    railPx +
    (sortedPlacedNodes.length > 0
      ? sortedPlacedNodes.length * BAND_SLOT_PX
      : bandWidthCells * BAND_SLOT_PX);
  const bandPxHeight = bandHeightCells * CELL_H;

  if (storylines.length === 0) {
    return (
      <div className="se-band se-band--empty" style={{ width: bandPxWidth, height: bandPxHeight }}>
        {t('superElement.empty.noStorylines')}
      </div>
    );
  }
  return (
    <div className="se-band" style={{ width: bandPxWidth, height: bandPxHeight }}>
      {storylines.map((s, idx) => (
        <div
          key={`lane-${s.id}`}
          className="se-band__lane"
          style={{ top: BAND_PAD_PX + idx * CELL_H, height: CELL_H }}
        />
      ))}

      <svg className="se-band__transits" aria-hidden="true">
        {transits.map((transit) => (
          <line
            key={transit.key}
            x1={transit.x1}
            y1={transit.y1}
            x2={transit.x2}
            y2={transit.y2}
            stroke={transit.color}
            strokeWidth={1}
            strokeDasharray="3 3"
            opacity={0.55}
          />
        ))}
      </svg>

      {sortedPlacedNodes.map((node, idx) => {
        const primaryId = primaryStorylineByNode[node.id] ?? null;
        const rowIdx = rowIndexByStoryline.get(primaryId ?? '');
        if (rowIdx === undefined) return null;
        const sl = primaryId ? storylineById.get(primaryId) : undefined;
        const color = sl?.color || 'hsl(var(--ink-4))';
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
            className={`se-band__pill glass glass--rest${isLinkSource ? ' is-held' : ''}${
              node.summary ? '' : ' is-title-only'
            }`}
            style={
              {
                left: railPx + idx * BAND_SLOT_PX,
                top: BAND_PAD_PX + rowIdx * CELL_H + 3,
                width: BAND_PILL_PX,
                height: CELL_H - 6,
                '--glass-cc': color,
              } as CSSProperties
            }
          >
            <div className="se-band__pill-title">{node.title || t('common.untitled')}</div>
            {node.summary && <div className="se-band__pill-summary">{node.summary}</div>}
          </div>
        );
      })}

      <div className="se-band__rail" style={{ width: railPx }}>
        {storylines.map((s, idx) => {
          const color = s.color || 'hsl(var(--ink-4))';
          return (
            <button
              key={`name-${s.id}`}
              type="button"
              className="se-band__name sand-cell"
              style={
                {
                  top: BAND_PAD_PX + idx * CELL_H + (CELL_H - 24) / 2,
                  maxWidth: railPx - 12,
                  '--cell-c': color,
                } as CSSProperties
              }
              onClick={(e) => {
                e.stopPropagation();
                onStorylineClick?.(s.id);
              }}
            >
              <KindMark kind="storyline" color={color} />
              <span className="se-band__name-text">{s.name || t('common.untitled')}</span>
              <i className="cell-ring" aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

export const SuperElementChapterBand = memo(ChapterBand);
