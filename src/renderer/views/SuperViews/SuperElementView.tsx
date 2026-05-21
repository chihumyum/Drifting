import { useState, useMemo, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { X } from 'lucide-react';
import { useDataStore } from '../../store/data-store';
import { useUiStore } from '../../store/ui-store';
import { useAuthStore } from '../../store/auth';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import type { BookElement, BookElementCategory } from '../../domain/book-element';
import type { BookNode } from '../../domain/book-node';
import type { Storyline } from '../../domain/storyline';
import {
  solveSuperElementLayout,
  type LayoutInput,
  type LayoutPlacement,
} from '../../lib/super-element-layout';
import { ElementCardPopover, type AnchorRect } from './ElementCardPopover';
import { useEntityRelations } from '../../usecase/useEntityRelations';

// Visual cell dimensions for CATEGORY world. Each element card occupies one
// cell. Categories expand by adding cells along whichever axis the
// group/element layout demands. Taller cells make the canvas taller; wider
// cells make horizontal scrolling more frequent.
const CELL_W = 96;
const CELL_H = 56;

// Chapter band geometry, decoupled from category cells. Pills are FIXED
// width (so a chapter title can read at any zoom); slot pitch controls
// how compact the overall band is — narrower slot = shorter timeline.
// Adjust BAND_SLOT_PX to compress / stretch the band without changing
// pill size.
const BAND_PILL_PX = 110;
const BAND_SLOT_PX = 120;

// Group-header strip rendered between groups inside a category box. Pixels,
// NOT cells — so headers don't gobble a full card row when the category
// only has 1–2 groups. Only rendered when a category has 2+ named groups
// (a single group's label is redundant with the category legend on top).
const GROUP_HEADER_PX = 16;

// Inner padding around the card grid inside a category box. Top padding
// leaves room for the legend-straddles-border treatment to clear the first
// card; bottom padding mirrors it for symmetry.
const CATEGORY_INNER_PAD_X = 3;
const CATEGORY_INNER_PAD_Y_TOP = 8;
const CATEGORY_INNER_PAD_Y_BOTTOM = 4;

// Zoom range; matches the BottomTimeline expanded-scale ergonomics.
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2.0;

// EntityReference doesn't carry a free-form `kind` like BookNodeEdge does,
// so we use `origin` as the classification axis. Stroke style + colour are
// derived from origin; visibility is toggled by the header filter chips.
// If the schema grows a `kind` column in the future, swap this for a hash-
// palette like GraphView's colorForKind without touching the renderer.
type EdgeOrigin = 'manual' | 'auto' | 'ai';

const EDGE_ORIGIN_META: Record<EdgeOrigin, { color: string; label: string; dash: string | null }> = {
  manual: { color: 'hsl(var(--ink-2))', label: '手动', dash: null },
  auto: { color: 'hsl(var(--story-4))', label: '自动检测', dash: '4 3' },
  ai: { color: 'hsl(var(--story-2))', label: 'AI', dash: '1 3' },
};

const EDGE_SELECTED_WIDTH = 2.2;
const EDGE_DEFAULT_WIDTH = 1.2;
const EDGE_HOVER_WIDTH = 1.8;

// localStorage key for the viewport (pan + zoom) per project. Restoring on
// re-entry preserves the user's mental map — they don't have to re-pan to
// the iceberg every time they pop the view.
function viewportStorageKey(projectId: string | undefined): string | null {
  if (!projectId) return null;
  return `super-element-view:viewport:${projectId}`;
}

interface GroupInternalLayout {
  groupName: string | null;
  items: BookElement[];
  /** Y offset of the group's first card row, in pixels relative to box top. */
  cardRowsTopPx: number;
  /** Number of card rows this group occupies (1 if items.length === 0). */
  cardRows: number;
  /** Y offset of the group's header strip, in pixels. -1 if no header. */
  headerTopPx: number;
}

interface CategoryRenderModel {
  category: BookElementCategory | null; // null for fallback (e.g. orphan elements)
  categoryId: string;
  groups: GroupInternalLayout[];
  widthCells: number;
  heightCells: number;
  /** Exact rendered height of the box in pixels, before snapping to cells. */
  contentHeightPx: number;
  totalElements: number;
}

/**
 * Compute the in-cell layout for one category. No more dedicated header row —
 * the category name/count is drawn ON the box's top border via a legend
 * label. Group separators are pixel-sized strips (GROUP_HEADER_PX), inserted
 * BETWEEN groups, so a category with one group has zero group chrome.
 *
 * The box's outer height is snapped UP to the next CELL_H boundary so the
 * skyline solver can keep its integer cell coordinates.
 */
function buildCategoryRenderModel(
  categoryId: string,
  category: BookElementCategory | null,
  elements: BookElement[],
): CategoryRenderModel {
  // Bucket elements by groupName; null group goes last with no header.
  const buckets = new Map<string | null, BookElement[]>();
  for (const el of elements) {
    const key = el.groupName?.trim() || null;
    const list = buckets.get(key) ?? [];
    list.push(el);
    buckets.set(key, list);
  }
  const named: { groupName: string; items: BookElement[] }[] = [];
  let ungrouped: BookElement[] = [];
  buckets.forEach((items, key) => {
    if (key === null) ungrouped = items;
    else named.push({ groupName: key, items });
  });
  named.sort((a, b) => a.groupName.localeCompare(b.groupName));

  const orderedGroups: { groupName: string | null; items: BookElement[] }[] = [
    ...named,
    ...(ungrouped.length > 0 ? [{ groupName: null, items: ungrouped }] : []),
  ];

  const totalElements = elements.length;

  // Empty category: a single empty placeholder cell, per design decision 13.
  if (totalElements === 0) {
    return {
      category,
      categoryId,
      groups: [],
      widthCells: 2,
      heightCells: 1,
      contentHeightPx: CELL_H,
      totalElements: 0,
    };
  }

  // Width formula picks the tightest grid that's still wider than tall, so
  // cards dominate the box. Multi-group categories enforce a min of 2 so
  // group headers have room to read; single-group categories can go down
  // to 1 cell wide.
  const minWidth = orderedGroups.length > 1 ? 2 : 1;
  const widthCells = Math.max(minWidth, Math.min(6, Math.ceil(Math.sqrt(totalElements))));
  // Show group dividers only when there's something to disambiguate from.
  // One group → its name has nothing to contrast with, so we omit the
  // header strip and let the cards fill the box.
  const showGroupHeaders = orderedGroups.length > 1;

  // Internal layout pass — pixels, top-down.
  let cursorPx = CATEGORY_INNER_PAD_Y_TOP;
  const groups: GroupInternalLayout[] = [];
  orderedGroups.forEach((g, idx) => {
    let headerTopPx = -1;
    if (showGroupHeaders && g.groupName !== null) {
      headerTopPx = cursorPx;
      cursorPx += GROUP_HEADER_PX;
    } else if (showGroupHeaders && idx > 0) {
      // Anonymous "ungrouped" bucket coming after named groups still needs
      // a visual divide — a small breathing strip with no label.
      cursorPx += 6;
    }
    const cardRows = Math.max(1, Math.ceil(g.items.length / widthCells));
    const cardRowsTopPx = cursorPx;
    cursorPx += cardRows * CELL_H;
    groups.push({
      groupName: g.groupName,
      items: g.items,
      cardRowsTopPx,
      cardRows,
      headerTopPx,
    });
  });

  const contentHeightPx = cursorPx + CATEGORY_INNER_PAD_Y_BOTTOM;
  const heightCells = Math.max(1, Math.ceil(contentHeightPx / CELL_H));

  return {
    category,
    categoryId,
    groups,
    widthCells,
    heightCells,
    contentHeightPx,
    totalElements,
  };
}

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
interface ChapterBandProps {
  storylines: Storyline[];
  nodes: BookNode[];
  nodeStorylineMapping: Record<string, string[]>;
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
  bandWidthCells,
  bandHeightCells,
  onNodeClick,
  linkSourceNodeId,
}: ChapterBandProps) {
  const placedNodes = useMemo(
    () => nodes.filter((n) => n.mainStorylineId != null),
    [nodes],
  );

  const storylineById = useMemo(
    () => new Map(storylines.map((s) => [s.id, s])),
    [storylines],
  );
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
        if (a.mainStorylineId === sl.id && b.mainStorylineId === sl.id) continue;
        const rowA = rowIndexByStoryline.get(a.mainStorylineId ?? '');
        const rowB = rowIndexByStoryline.get(b.mainStorylineId ?? '');
        const idxA = slotIndexByNodeId.get(a.id);
        const idxB = slotIndexByNodeId.get(b.id);
        if (rowA === undefined || rowB === undefined) continue;
        if (idxA === undefined || idxB === undefined) continue;
        out.push({
          key: `${sl.id}:${a.id}->${b.id}`,
          x1: slotCenterX(idxA),
          y1: (1 + rowA) * CELL_H + CELL_H / 2, // +1 for the axis row
          x2: slotCenterX(idxB),
          y2: (1 + rowB) * CELL_H + CELL_H / 2,
          color: sl.color || 'hsl(var(--ink-4))',
        });
      }
    }
    return out;
  }, [storylines, sortedByStoryline, rowIndexByStoryline, slotIndexByNodeId]);

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
        no storylines yet
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
      {/* Axis row — thin label, just a marker. */}
      <div
        style={{
          position: 'absolute',
          left: 8,
          top: 4,
          height: CELL_H - 8,
          display: 'flex',
          alignItems: 'center',
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          color: 'hsl(var(--ink-4))',
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
        }}
      >
        chapters · book order
      </div>

      {/* Storyline lane backgrounds (thin tint behind each row). */}
      {storylines.map((s, idx) => (
        <div
          key={`lane-${s.id}`}
          style={{
            position: 'absolute',
            left: 0,
            top: (idx + 1) * CELL_H,
            width: bandPxWidth,
            height: CELL_H,
            borderTop: idx === 0 ? '1px solid hsl(var(--rule) / 0.6)' : 'none',
            borderBottom: '1px dotted hsl(var(--rule) / 0.4)',
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
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
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

      {/* Node pills. Read-only for summary inspection (hover title); shift-
          click marks the pill as a link source for cross-band relations. */}
      {sortedPlacedNodes.map((node, idx) => {
        const rowIdx = rowIndexByStoryline.get(node.mainStorylineId ?? '');
        if (rowIdx === undefined) return null;
        const sl = storylineById.get(node.mainStorylineId ?? '');
        const color = sl?.color || 'hsl(var(--ink-4))';
        const x = idx * BAND_SLOT_PX;
        const y = (1 + rowIdx) * CELL_H + 6;
        const isLinkSource = linkSourceNodeId === node.id;
        return (
          <div
            key={node.id}
            data-super-card="node"
            data-node-id={node.id}
            title={node.summary ? `${node.title || '未命名'}\n\n${node.summary}` : node.title || '未命名'}
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
              height: CELL_H - 12,
              borderRadius: 3,
              background: isLinkSource ? 'hsl(var(--paper-deep))' : 'hsl(var(--paper))',
              border: `1px solid ${color}`,
              borderLeft: `3px solid ${color}`,
              outline: isLinkSource ? `2px dashed ${color}` : 'none',
              outlineOffset: isLinkSource ? '1px' : 0,
              display: 'flex',
              alignItems: 'center',
              padding: '0 8px',
              fontFamily: 'var(--font-serif)',
              fontSize: 11,
              color: 'hsl(var(--ink-1))',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              cursor: 'pointer',
            }}
          >
            {node.title || '未命名'}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Renders one category box at its assigned grid position. Internal layout
 * is computed in PIXELS (no dedicated header row): a fieldset-style legend
 * floats on the top border with the category name + count; named groups
 * get thin horizontal-rule strips between card rows; element cards fill
 * the rest of the surface so the box reads as "mostly cards".
 */
interface CategoryBoxProps {
  model: CategoryRenderModel;
  placement: LayoutPlacement;
  onElementClick: (element: BookElement, anchor: DOMRect, opts: { shiftKey: boolean }) => void;
  onCategoryClick: (categoryId: string) => void;
  /** Element id currently flagged as the link source (shift-click pending). */
  linkSourceElementId?: string | null;
  /**
   * Mutable map the parent owns so it can read element-card DOM rects for
   * drift-edge geometry. Each card writes itself in on mount and removes
   * itself on unmount.
   */
  elementCardRefs?: React.MutableRefObject<Map<string, HTMLDivElement>>;
}

function CategoryBox({
  model,
  placement,
  onElementClick,
  onCategoryClick,
  linkSourceElementId,
  elementCardRefs,
}: CategoryBoxProps) {
  const { category, groups, widthCells, heightCells, totalElements } = model;
  const accent = category?.color ?? 'hsl(var(--ink-4))';
  const boxPxWidth = widthCells * CELL_W;
  const boxPxHeight = heightCells * CELL_H;

  return (
    <div
      style={{
        position: 'absolute',
        left: placement.gridX * CELL_W,
        top: placement.gridY * CELL_H,
        width: boxPxWidth,
        height: boxPxHeight,
        background: 'hsl(var(--paper))',
        // Border picks up the category accent so each box reads as a
        // distinct "shelf" of that category's color at a glance.
        border: `1.5px solid ${accent}`,
        borderRadius: 3,
        boxShadow: '0 1px 3px hsl(var(--ink-1) / 0.05)',
      }}
    >
      {/* Legend straddling the top border — fieldset/legend pattern. The
          paper background punches a hole through the border so the label
          looks set into the frame. Cards inside are padded down so they
          never collide with the legend's bottom edge. */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onCategoryClick(model.categoryId);
        }}
        title={category?.name ?? model.categoryId}
        style={{
          position: 'absolute',
          left: 10,
          top: -9,
          height: 14,
          background: 'hsl(var(--paper))',
          padding: '0 7px',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          border: 'none',
          cursor: 'pointer',
          fontFamily: 'var(--font-mono)',
          fontSize: 9.5,
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          color: accent,
          fontWeight: 600,
          maxWidth: boxPxWidth - 20,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: 1.5,
            background: accent,
            flexShrink: 0,
          }}
        />
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: 'hsl(var(--ink-1))',
          }}
        >
          {category?.name ?? '未命名'}
        </span>
        <span style={{ color: 'hsl(var(--ink-4))', flexShrink: 0, fontWeight: 400 }}>
          ·{totalElements}
        </span>
      </button>

      {/* Group headers — thin strips between card rows. Skipped entirely
          when a group has no name (ungrouped bucket). */}
      {groups
        .filter((g) => g.headerTopPx >= 0 && g.groupName !== null)
        .map((g) => (
          <div
            key={`group-${g.groupName}`}
            style={{
              position: 'absolute',
              left: 6,
              top: g.headerTopPx,
              width: boxPxWidth - 12,
              height: GROUP_HEADER_PX,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              pointerEvents: 'none',
              fontFamily: 'var(--font-mono)',
              fontSize: 9,
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              color: 'hsl(var(--ink-4))',
            }}
          >
            <span
              aria-hidden
              style={{
                width: 10,
                height: 1,
                background: 'hsl(var(--rule) / 0.6)',
                flexShrink: 0,
              }}
            />
            <span style={{ flexShrink: 0 }}>{g.groupName}</span>
            <span
              aria-hidden
              style={{
                flex: 1,
                height: 1,
                background: 'hsl(var(--rule) / 0.6)',
              }}
            />
          </div>
        ))}

      {/* Element cards — laid out group by group. */}
      {groups.flatMap((g) =>
        g.items.map((element, idx) => {
          const col = idx % widthCells;
          const rowOffset = Math.floor(idx / widthCells);
          const left = CATEGORY_INNER_PAD_X + col * CELL_W;
          const top = g.cardRowsTopPx + rowOffset * CELL_H;
          const width = CELL_W;
          const height = CELL_H;
          const isLinkSource = linkSourceElementId === element.id;
          return (
            <div
              key={element.id}
              data-super-card="element"
              data-element-id={element.id}
              ref={(node) => {
                if (!elementCardRefs) return;
                if (node) elementCardRefs.current.set(element.id, node);
                else elementCardRefs.current.delete(element.id);
              }}
              onClick={(e) => {
                e.stopPropagation();
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                onElementClick(element, rect, { shiftKey: e.shiftKey });
              }}
              style={{
                position: 'absolute',
                left: left + 3,
                top: top + 3,
                width: width - 6,
                height: height - 6,
                border: isLinkSource ? `1.5px solid ${accent}` : '1px solid hsl(var(--rule))',
                borderRadius: 2,
                background: isLinkSource ? 'hsl(var(--paper-deep))' : 'hsl(var(--paper))',
                outline: isLinkSource ? `2px dashed ${accent}` : 'none',
                outlineOffset: isLinkSource ? '1px' : 0,
                padding: '5px 7px',
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                cursor: 'pointer',
                transition: 'background 120ms, border-color 120ms, outline-color 120ms',
                overflow: 'hidden',
              }}
              onMouseEnter={(e) => {
                if (isLinkSource) return;
                e.currentTarget.style.background = 'hsl(var(--paper-deep))';
                e.currentTarget.style.borderColor = accent;
              }}
              onMouseLeave={(e) => {
                if (isLinkSource) return;
                e.currentTarget.style.background = 'hsl(var(--paper))';
                e.currentTarget.style.borderColor = 'hsl(var(--rule))';
              }}
            >
              <div
                style={{
                  fontFamily: 'var(--font-serif)',
                  fontSize: 11.5,
                  lineHeight: 1.15,
                  color: 'hsl(var(--ink-1))',
                  fontWeight: 500,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
                title={element.name}
              >
                <span aria-hidden style={{ color: accent, marginRight: 4, fontStyle: 'italic' }}>
                  ◆
                </span>
                {element.name}
              </div>
              {element.summary && (
                <div
                  title={element.summary}
                  style={{
                    fontSize: 9.5,
                    lineHeight: 1.3,
                    color: 'hsl(var(--ink-4))',
                    overflow: 'hidden',
                    // Multi-line clamp: lets the summary breathe vertically
                    // up to the card's available height, ellipsizing the
                    // overflow rather than truncating to one line.
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    flex: 1,
                  }}
                >
                  {element.summary}
                </div>
              )}
            </div>
          );
        }),
      )}

      {/* Empty-state placeholder — single empty cell, per design decision 13. */}
      {totalElements === 0 && (
        <div
          style={{
            position: 'absolute',
            left: 3,
            top: 3,
            width: boxPxWidth - 6,
            height: boxPxHeight - 6,
            border: '1px dashed hsl(var(--rule))',
            borderRadius: 2,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'hsl(var(--ink-4))',
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
          }}
        >
          empty
        </div>
      )}
    </div>
  );
}

export function SuperElementView() {
  const setActiveSuperView = useUiStore((s) => s.setActiveSuperView);
  const close = useCallback(() => setActiveSuperView('none'), [setActiveSuperView]);
  const { openEntity, projectId } = useProjectNavigation();
  const userId = useAuthStore((s) => s.user?.id) ?? '';

  const {
    bookElements,
    bookElementCategories,
    bookNodes,
    storylines,
    nodeStorylineMapping,
    manualReferences,
  } = useDataStore();

  // Active popover state. Card click opens the two-tier editor; the popover
  // itself owns ESC + outside-click dismissal, but the SuperElementView ESC
  // listener below also closes it as a safety net.
  const [activePopover, setActivePopover] = useState<{
    elementId: string;
    anchor: AnchorRect;
  } | null>(null);

  // Selection / linking / drift-panel state — declared up front so the ESC
  // stack and pointer-dismiss listener below can reference them. Their
  // commit handlers (confirmPendingLink / deleteSelectedEdge) and derived
  // edge data come later, after layout is computed.
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [linkSource, setLinkSource] = useState<
    { kind: 'element' | 'node'; id: string } | null
  >(null);
  const [pendingLink, setPendingLink] = useState<
    | {
        source: { kind: 'element' | 'node'; id: string };
        target: { kind: 'element' | 'node'; id: string };
      }
    | null
  >(null);
  const [driftPanelOpen, setDriftPanelOpen] = useState(false);
  const [hiddenOrigins, setHiddenOrigins] = useState<Set<EdgeOrigin>>(() => new Set());

  // ESC stack — most-recent overlay pops first. The popover registers its
  // own capture-phase ESC, so we don't include it in our priority list
  // (window-bubble fires AFTER popover's capture-handler closes it). For
  // every other overlay, we own the dismiss here.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (activePopover) return; // popover handles it
      if (pendingLink) {
        setPendingLink(null);
        return;
      }
      if (selectedEdgeId) {
        setSelectedEdgeId(null);
        return;
      }
      if (linkSource) {
        setLinkSource(null);
        return;
      }
      if (driftPanelOpen) {
        setDriftPanelOpen(false);
        return;
      }
      close();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [close, activePopover, pendingLink, selectedEdgeId, linkSource, driftPanelOpen]);

  // Dismiss the edge selection on any click that doesn't land on an edge
  // or the × badge. Edge / badge handlers stopPropagation so they don't
  // bubble up here.
  useEffect(() => {
    if (!selectedEdgeId) return;
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t) return;
      if (t.closest('[data-super-edge]') || t.closest('[data-super-edge-delete]')) return;
      setSelectedEdgeId(null);
    };
    document.addEventListener('pointerdown', onPointer, true);
    return () => document.removeEventListener('pointerdown', onPointer, true);
  }, [selectedEdgeId]);

  // ---- Build category render models (size + internal layout) ----
  const elementsByCategory = useMemo(() => {
    const m = new Map<string, BookElement[]>();
    for (const cat of bookElementCategories) m.set(cat.id, []);
    for (const el of bookElements) {
      if (!m.has(el.categoryId)) m.set(el.categoryId, []);
      m.get(el.categoryId)!.push(el);
    }
    return m;
  }, [bookElements, bookElementCategories]);

  const categoryModels = useMemo<CategoryRenderModel[]>(() => {
    const known = new Set(bookElementCategories.map((c) => c.id));
    const models: CategoryRenderModel[] = [];
    for (const cat of bookElementCategories) {
      const items = elementsByCategory.get(cat.id) ?? [];
      models.push(buildCategoryRenderModel(cat.id, cat, items));
    }
    // Catch orphan elements (categoryId referencing a missing category) so
    // they're still visible. Rare — the schema enforces categoryId references —
    // but better to surface them than to silently swallow.
    const orphanBuckets = new Map<string, BookElement[]>();
    for (const el of bookElements) {
      if (known.has(el.categoryId)) continue;
      const list = orphanBuckets.get(el.categoryId) ?? [];
      list.push(el);
      orphanBuckets.set(el.categoryId, list);
    }
    orphanBuckets.forEach((items, cid) => {
      models.push(buildCategoryRenderModel(cid, null, items));
    });
    return models;
  }, [bookElementCategories, bookElements, elementsByCategory]);

  // ---- Layout ----
  // Band height in cells: 1 axis row + one row per storyline. When there
  // are no storylines, reserve 2 cells so the empty-state placeholder has
  // somewhere visible to sit.
  const bandHeightCells = Math.max(2, storylines.length + 1);

  // Band width in cells: spans the bookOrder range of placed nodes, plus
  // 2 cells slack on each side for the pill width.
  const placedNodes = useMemo(
    () => bookNodes.filter((n) => n.mainStorylineId != null),
    [bookNodes],
  );
  // bandWidthCells is now purely a fallback for the empty-state band; when
  // there are chapters, the band sizes itself to the slot count via the
  // ChapterBand component's internal math.
  const bandWidthCells = Math.max(8, placedNodes.length);

  // The band's leftmost edge in WORLD pixels. We center the band on world
  // x=0 so the category solver's anchorX=0 corresponds to the band's visual
  // center, giving the iceberg shape the right balance point.
  const bandPxWidth = bandWidthCells * BAND_SLOT_PX;
  const bandWorldLeft = -bandPxWidth / 2;
  const bandWorldCenterY = (bandHeightCells * CELL_H) / 2;

  const layout = useMemo(() => {
    const inputs: LayoutInput[] = categoryModels.map((m) => ({
      id: m.categoryId,
      widthCells: m.widthCells,
      heightCells: m.heightCells,
      pinned:
        m.category?.layoutMode === 'pinned' &&
        m.category.gridX !== null &&
        m.category.gridY !== null
          ? { gridX: m.category.gridX, gridY: m.category.gridY }
          : undefined,
    }));
    return solveSuperElementLayout(inputs, {
      bandHeightCells,
      anchorX: 0, // categories cluster around world x=0 (== band center)
      searchExtent: 96,
      balanceAlpha: 1.0,
    });
  }, [categoryModels, bandHeightCells]);

  const placementById = useMemo(() => {
    const m = new Map<string, LayoutPlacement>();
    layout.placements.forEach((p) => m.set(p.id, p));
    return m;
  }, [layout]);

  // ---- World-space coordinate maps for edge rendering ----
  // Element card center (world pixels). Computed by walking the same
  // groups/columns/rows layout the renderer uses in CategoryBox.
  const elementCenters = useMemo(() => {
    const m = new Map<string, { x: number; y: number; categoryId: string }>();
    for (const model of categoryModels) {
      const placement = placementById.get(model.categoryId);
      if (!placement) continue;
      const boxX = placement.gridX * CELL_W;
      const boxY = placement.gridY * CELL_H;
      for (const g of model.groups) {
        g.items.forEach((el, idx) => {
          const col = idx % model.widthCells;
          const rowOffset = Math.floor(idx / model.widthCells);
          const x = boxX + CATEGORY_INNER_PAD_X + col * CELL_W + CELL_W / 2;
          const y = boxY + g.cardRowsTopPx + rowOffset * CELL_H + CELL_H / 2;
          m.set(el.id, { x, y, categoryId: model.categoryId });
        });
      }
    }
    return m;
  }, [categoryModels, placementById]);

  // Chapter pill center (world pixels). Drift nodes (mainStorylineId=null)
  // are excluded — they live in the optional drift panel and use a
  // viewport-space SVG layer instead.
  const sortedPlacedNodesAll = useMemo(
    () => placedNodes.slice().sort((a, b) => a.bookOrder - b.bookOrder),
    [placedNodes],
  );
  const nodeCenters = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    const rowIndex = new Map<string, number>();
    storylines.forEach((s, i) => rowIndex.set(s.id, i));
    sortedPlacedNodesAll.forEach((n, idx) => {
      const rowIdx = rowIndex.get(n.mainStorylineId ?? '');
      if (rowIdx === undefined) return;
      const x = bandWorldLeft + idx * BAND_SLOT_PX + BAND_PILL_PX / 2;
      const y = (1 + rowIdx) * CELL_H + CELL_H / 2;
      m.set(n.id, { x, y });
    });
    return m;
  }, [sortedPlacedNodesAll, storylines, bandWorldLeft]);

  const driftNodes = useMemo(
    () => bookNodes.filter((n) => n.mainStorylineId == null).sort((a, b) => a.bookOrder - b.bookOrder),
    [bookNodes],
  );

  // ---- Reference / edge state ----
  const { addRelation, removeRelation } = useEntityRelations({
    projectId: projectId ?? '',
    userId,
  });

  // Filter & build edges sourced from the manual-reference store. v1 only
  // pulls non-inline refs (fromBlockId IS NULL — that's the store filter);
  // inline @-mention refs live in reference-index.service and aren't
  // surfaced here yet. The edge endpoints must be either element ↔ element
  // or element ↔ node (we don't render pure node ↔ node, that's GraphView's
  // job). Drift-touching edges are also dropped here and rendered by the
  // viewport-space drift layer instead.
  const driftIds = useMemo(() => new Set(driftNodes.map((n) => n.id)), [driftNodes]);

  type WorldEdge = {
    id: string;
    refId: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    origin: EdgeOrigin;
    fromName: string;
    toName: string;
  };
  const worldEdges = useMemo<WorldEdge[]>(() => {
    const out: WorldEdge[] = [];
    for (const ref of manualReferences) {
      const origin = (ref.origin as EdgeOrigin) ?? 'manual';
      if (hiddenOrigins.has(origin)) continue;
      const fromIsEl = ref.fromKind === 'element';
      const toIsEl = ref.toKind === 'element';
      const fromIsNode = ref.fromKind === 'node';
      const toIsNode = ref.toKind === 'node';
      // Skip refs that don't involve an element (pure node↔node belongs to
      // GraphView; memo/material/patch refs aren't visible here).
      if (!fromIsEl && !toIsEl) continue;
      // Drift-touching refs go to the drift layer instead.
      if (fromIsNode && driftIds.has(ref.fromId)) continue;
      if (toIsNode && driftIds.has(ref.toId)) continue;
      const fromPt = fromIsEl
        ? elementCenters.get(ref.fromId)
        : fromIsNode
          ? nodeCenters.get(ref.fromId)
          : null;
      const toPt = toIsEl
        ? elementCenters.get(ref.toId)
        : toIsNode
          ? nodeCenters.get(ref.toId)
          : null;
      if (!fromPt || !toPt) continue;
      const fromName = fromIsEl
        ? bookElements.find((e) => e.id === ref.fromId)?.name ?? '?'
        : fromIsNode
          ? bookNodes.find((n) => n.id === ref.fromId)?.title ?? '?'
          : '?';
      const toName = toIsEl
        ? bookElements.find((e) => e.id === ref.toId)?.name ?? '?'
        : toIsNode
          ? bookNodes.find((n) => n.id === ref.toId)?.title ?? '?'
          : '?';
      out.push({
        id: ref.id,
        refId: ref.id,
        x1: fromPt.x,
        y1: fromPt.y,
        x2: toPt.x,
        y2: toPt.y,
        origin,
        fromName,
        toName,
      });
    }
    return out;
  }, [
    manualReferences,
    hiddenOrigins,
    elementCenters,
    nodeCenters,
    driftIds,
    bookElements,
    bookNodes,
  ]);

  // Origins actually present in the data — drives which chips render.
  const availableOrigins = useMemo<EdgeOrigin[]>(() => {
    const s = new Set<EdgeOrigin>();
    manualReferences.forEach((r) => {
      const o = (r.origin as EdgeOrigin) ?? 'manual';
      // Filter to refs that COULD render here (element-touching).
      if (r.fromKind === 'element' || r.toKind === 'element') s.add(o);
    });
    return (['manual', 'auto', 'ai'] as EdgeOrigin[]).filter((o) => s.has(o));
  }, [manualReferences]);

  // ---- Pan + zoom ----
  // Lazy initial state seeds the world transform so the FIRST frame already
  // has the band roughly in viewport center (rather than at world origin,
  // which would put it offscreen-top-left for one frame). The persistence
  // restore effect below refines this to the exact saved spot.
  const [pan, setPan] = useState<{ x: number; y: number }>(() => {
    if (typeof window === 'undefined') return { x: 0, y: 0 };
    return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  });
  const [zoom, setZoom] = useState(1);
  const isPanningRef = useRef(false);
  const panStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  // Refs mirror the latest pan/zoom for the native wheel listener (registered
  // once, no React closure deps) so it always sees fresh values.
  const panRef = useRef(pan);
  const zoomRef = useRef(zoom);
  useEffect(() => {
    panRef.current = pan;
  }, [pan]);
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  // ---- Viewport persistence ----
  // Persist (pan, zoom) per project so popping back into the view keeps the
  // user's spot on the iceberg. We gate the save on a `restored` STATE
  // (not a ref) so that the save effect waits for the restore's setPan/
  // setZoom to actually commit before its first write — otherwise the same
  // render that restores would also save the pre-restore default and clobber
  // whatever was previously stored.
  const [restoredForKey, setRestoredForKey] = useState<string | null>(null);

  const initialCenter = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return { pan: { x: 0, y: 0 }, zoom: 1 };
    return {
      pan: {
        // World x=0 lands at the band's horizontal center.
        x: viewport.clientWidth / 2,
        // Band's vertical midpoint is at world y = bandWorldCenterY.
        y: viewport.clientHeight / 2 - bandWorldCenterY,
      },
      zoom: 1,
    };
  }, [bandWorldCenterY]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const key = viewportStorageKey(projectId);
    if (!key) return;
    if (restoredForKey === key) return;
    let next: { pan: { x: number; y: number }; zoom: number } | null = null;
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw) as {
          pan?: { x: number; y: number };
          zoom?: number;
        };
        if (
          parsed &&
          parsed.pan &&
          typeof parsed.pan.x === 'number' &&
          typeof parsed.pan.y === 'number' &&
          typeof parsed.zoom === 'number'
        ) {
          next = {
            pan: parsed.pan,
            zoom: Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, parsed.zoom)),
          };
        }
      }
    } catch {
      /* corrupt storage — fall through to default centering */
    }
    if (!next) next = initialCenter();
    setPan(next.pan);
    setZoom(next.zoom);
    setRestoredForKey(key);
  }, [projectId, initialCenter, restoredForKey]);

  // Save whenever pan / zoom changes — but only after restore has committed
  // for the current project. localStorage writes are fast enough that we
  // don't bother debouncing pan drags.
  useEffect(() => {
    const key = viewportStorageKey(projectId);
    if (!key) return;
    if (restoredForKey !== key) return;
    try {
      localStorage.setItem(key, JSON.stringify({ pan, zoom }));
    } catch {
      /* quota or privacy mode — ignore */
    }
  }, [projectId, pan, zoom, restoredForKey]);

  // Native wheel listener with passive:false so preventDefault is honored.
  // (React's synthetic onWheel is passive, which is what triggered the
  // browser warning + the rogue native zoom that broke pivot-around-cursor.)
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (e: WheelEvent) => {
      // ⌘/Ctrl + wheel → zoom around cursor. Plain wheel → pan.
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = viewport.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        // Negative deltaY = wheel forward = zoom in. Trackpad pinch-zoom on
        // macOS dispatches wheel with ctrlKey=true regardless of physical
        // ⌘ state, so the same path covers both gestures.
        const factor = Math.exp(-e.deltaY * 0.0015);
        const prevZoom = zoomRef.current;
        const nextZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, prevZoom * factor));
        if (nextZoom === prevZoom) return;
        const realFactor = nextZoom / prevZoom;
        const prevPan = panRef.current;
        // Pivot pan so the world point under the cursor stays put:
        //   screenX = pan + zoom * worldX  =>  worldX = (screenX - pan) / zoom
        //   newPan = screenX - newZoom * worldX
        const nextPan = {
          x: cx - (cx - prevPan.x) * realFactor,
          y: cy - (cy - prevPan.y) * realFactor,
        };
        panRef.current = nextPan;
        zoomRef.current = nextZoom;
        setPan(nextPan);
        setZoom(nextZoom);
      } else {
        e.preventDefault();
        const prev = panRef.current;
        const next = { x: prev.x - e.deltaX, y: prev.y - e.deltaY };
        panRef.current = next;
        setPan(next);
      }
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Middle-click or background-left-click → pan. Left-clicks that
      // bubble up from cards / category buttons are filtered by the
      // currentTarget check.
      if (e.button !== 1 && !(e.button === 0 && e.target === e.currentTarget)) return;
      isPanningRef.current = true;
      panStartRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [pan.x, pan.y],
  );
  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!isPanningRef.current || !panStartRef.current) return;
    const start = panStartRef.current;
    const next = {
      x: start.panX + (e.clientX - start.x),
      y: start.panY + (e.clientY - start.y),
    };
    panRef.current = next;
    setPan(next);
  }, []);
  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    isPanningRef.current = false;
    panStartRef.current = null;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* element may have lost capture mid-drag — ignore */
    }
  }, []);

  // Reset view on demand — centers the band and resets zoom.
  const resetView = useCallback(() => {
    const initial = initialCenter();
    setPan(initial.pan);
    setZoom(initial.zoom);
  }, [initialCenter]);

  // ---- Entity click router ----
  // All shift-click pairing + popover-opening flows through here so element
  // and node cards share the same state machine.
  const handleEntityClick = useCallback(
    (
      kind: 'element' | 'node',
      id: string,
      rect: DOMRect,
      opts: { shiftKey: boolean },
    ) => {
      if (opts.shiftKey) {
        setLinkSource((prev) => {
          if (prev && prev.kind === kind && prev.id === id) return null; // toggle off
          return { kind, id };
        });
        return;
      }
      if (linkSource && !(linkSource.kind === kind && linkSource.id === id)) {
        setPendingLink({
          source: linkSource,
          target: { kind, id },
        });
        setLinkSource(null);
        return;
      }
      // Plain click → open popover (elements only). Clicking a node pill
      // without shift is a no-op — chapters are read-only per design.
      if (kind === 'element') {
        setActivePopover({
          elementId: id,
          anchor: {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          },
        });
      }
    },
    [linkSource],
  );

  // Commit a manual EntityReference for the pending link, then dismiss the
  // modal. Caller passes the modal source/target verbatim. No "kind" input
  // (the schema doesn't have one) — origin is always 'manual' for shift-
  // click pairings.
  const confirmPendingLink = useCallback(async () => {
    if (!pendingLink) return;
    try {
      await addRelation(
        pendingLink.source.kind,
        pendingLink.source.id,
        pendingLink.target.kind,
        pendingLink.target.id,
      );
    } catch {
      /* surfaced through optimistic-update rollback — UI is already reverted */
    } finally {
      setPendingLink(null);
    }
  }, [pendingLink, addRelation]);

  const deleteSelectedEdge = useCallback(async () => {
    if (!selectedEdgeId) return;
    const id = selectedEdgeId;
    setSelectedEdgeId(null);
    try {
      await removeRelation(id);
    } catch {
      /* rollback handles UI; nothing to undo here */
    }
  }, [selectedEdgeId, removeRelation]);

  // ---- Drift edges (viewport-space) ----
  // Drift node cards live in the bottom panel (position: fixed, NOT in the
  // world transform), so the SVG that connects drift cards to their linked
  // elements has to be in viewport coordinates. We measure both endpoints
  // via getBoundingClientRect on each animation frame while the panel is
  // mounted — same recipe as GraphView.
  const driftCardRefs = useRef(new Map<string, HTMLDivElement>());
  const elementCardRefs = useRef(new Map<string, HTMLDivElement>());
  const [driftEdgeGeom, setDriftEdgeGeom] = useState<
    Array<{
      id: string;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      origin: EdgeOrigin;
    }>
  >([]);
  useLayoutEffect(() => {
    if (!driftPanelOpen) {
      setDriftEdgeGeom([]);
      return;
    }
    let rafId = 0;
    let stop = false;
    const recompute = () => {
      const out: typeof driftEdgeGeom = [];
      for (const ref of manualReferences) {
        const origin = (ref.origin as EdgeOrigin) ?? 'manual';
        if (hiddenOrigins.has(origin)) continue;
        // Want exactly one drift endpoint + one element endpoint.
        const fromIsDriftNode = ref.fromKind === 'node' && driftIds.has(ref.fromId);
        const toIsDriftNode = ref.toKind === 'node' && driftIds.has(ref.toId);
        const fromIsEl = ref.fromKind === 'element';
        const toIsEl = ref.toKind === 'element';
        if (!((fromIsDriftNode && toIsEl) || (toIsDriftNode && fromIsEl))) continue;
        const driftId = fromIsDriftNode ? ref.fromId : ref.toId;
        const elementId = fromIsEl ? ref.fromId : ref.toId;
        const driftEl = driftCardRefs.current.get(driftId);
        const elEl = elementCardRefs.current.get(elementId);
        if (!driftEl || !elEl) continue;
        const r1 = driftEl.getBoundingClientRect();
        const r2 = elEl.getBoundingClientRect();
        out.push({
          id: ref.id,
          x1: r1.left + r1.width / 2,
          y1: r1.top + r1.height / 2,
          x2: r2.left + r2.width / 2,
          y2: r2.top + r2.height / 2,
          origin,
        });
      }
      setDriftEdgeGeom(out);
    };
    const tick = () => {
      if (stop) return;
      recompute();
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    // After the slide-in settles, throttle down to scroll / resize events.
    const stopTimer = window.setTimeout(() => {
      stop = true;
      cancelAnimationFrame(rafId);
    }, 600);
    const onScrollOrResize = () => recompute();
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      stop = true;
      cancelAnimationFrame(rafId);
      window.clearTimeout(stopTimer);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [driftPanelOpen, manualReferences, hiddenOrigins, driftIds]);

  return (
    <div
      className="super-element-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 250,
        background: 'hsl(var(--paper))',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header — minimal: title + reset + close */}
      <div
        style={{
          height: 44,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 18px',
          borderBottom: '1px solid hsl(var(--rule))',
          background: 'hsl(var(--paper-deep))',
          WebkitAppRegion: 'drag' as React.CSSProperties['WebkitAppRegion'],
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            // Leave room for macOS traffic lights.
            paddingLeft: typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac') ? 60 : 0,
          }}
        >
          <button
            onClick={close}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              border: '1px solid hsl(var(--rule))',
              background: 'transparent',
              color: 'hsl(var(--ink-2))',
              padding: '3px 10px',
              borderRadius: 3,
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
              cursor: 'pointer',
              WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'],
            }}
            title="ESC 关闭"
          >
            <span style={{ fontFamily: 'var(--font-serif)', fontStyle: 'italic' }}>‹</span>
            返回
          </button>
          <div
            style={{
              fontFamily: 'var(--font-serif)',
              fontSize: 14,
              color: 'hsl(var(--ink-1))',
              letterSpacing: '0.02em',
            }}
          >
            元素全景
            <em
              style={{
                fontStyle: 'italic',
                fontSize: 11,
                color: 'hsl(var(--ink-4))',
                marginLeft: 10,
              }}
            >
              {bookElementCategories.length} 类 · {bookElements.length} 元素
            </em>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'],
          }}
        >
          {/* Linking hint — surfaces when a shift-click is mid-flight, so
              users know they need to click a second target. */}
          {linkSource && (
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 9.5,
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                color: 'hsl(var(--ink-3))',
                background: 'hsl(var(--paper))',
                border: '1px dashed hsl(var(--ink-3))',
                borderRadius: 3,
                padding: '3px 8px',
              }}
            >
              选择第二个 {linkSource.kind === 'element' ? '元素 / 章节' : '元素 / 章节'} · ESC 取消
            </div>
          )}

          {/* Origin filter chips — toggles visibility of an origin family.
              EntityReference has no free-form `kind`, so we filter by the
              row's `origin` enum (manual / auto / ai). Chips only render
              when the origin actually has matching refs in the project. */}
          {availableOrigins.map((origin) => {
            const meta = EDGE_ORIGIN_META[origin];
            const visible = !hiddenOrigins.has(origin);
            return (
              <button
                key={origin}
                type="button"
                onClick={() =>
                  setHiddenOrigins((prev) => {
                    const next = new Set(prev);
                    if (next.has(origin)) next.delete(origin);
                    else next.add(origin);
                    return next;
                  })
                }
                title={visible ? `隐藏「${meta.label}」` : `显示「${meta.label}」`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  border: `1px solid ${visible ? meta.color : 'hsl(var(--rule))'}`,
                  background: visible ? 'hsl(var(--paper))' : 'transparent',
                  color: visible ? 'hsl(var(--ink-1))' : 'hsl(var(--ink-4))',
                  padding: '3px 8px',
                  borderRadius: 3,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9.5,
                  textTransform: 'uppercase',
                  letterSpacing: '0.1em',
                  cursor: 'pointer',
                  opacity: visible ? 1 : 0.55,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 1.5,
                    background: meta.color,
                    flexShrink: 0,
                  }}
                />
                {meta.label}
              </button>
            );
          })}

          {/* Drift panel toggle — mirrors GraphView's bottom-tab affordance
              but placed in the header for symmetry with the rest of the
              chrome here. */}
          {driftNodes.length > 0 && (
            <button
              type="button"
              onClick={() => setDriftPanelOpen((v) => !v)}
              title={driftPanelOpen ? '收起浮缀' : '展开浮缀'}
              style={{
                border: '1px solid hsl(var(--rule))',
                background: driftPanelOpen ? 'hsl(var(--ink-1))' : 'transparent',
                color: driftPanelOpen ? 'hsl(var(--paper))' : 'hsl(var(--ink-2))',
                padding: '3px 10px',
                borderRadius: 3,
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                textTransform: 'uppercase',
                letterSpacing: '0.12em',
                cursor: 'pointer',
              }}
            >
              浮缀 · {driftNodes.length}
            </button>
          )}

          <button
            onClick={resetView}
            style={{
              border: '1px solid hsl(var(--rule))',
              background: 'transparent',
              color: 'hsl(var(--ink-3))',
              padding: '3px 10px',
              borderRadius: 3,
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
              cursor: 'pointer',
            }}
            title="重置画布缩放与平移"
          >
            重置
          </button>
          <button
            onClick={close}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 24,
              border: '1px solid hsl(var(--rule))',
              background: 'transparent',
              borderRadius: 3,
              cursor: 'pointer',
              color: 'hsl(var(--ink-3))',
            }}
            title="关闭 (ESC)"
          >
            <X size={14} />
          </button>
        </div>

        {/* macOS drag-region opt-out for interactive controls. */}
        <style>{`
          .super-element-overlay button,
          .super-element-overlay [data-super-card],
          .super-element-overlay [data-super-edge],
          .super-element-overlay [data-super-edge-delete],
          .super-element-overlay [data-super-modal],
          .super-element-overlay [data-super-drift],
          .super-element-overlay input,
          .super-element-overlay textarea { -webkit-app-region: no-drag; }
        `}</style>
      </div>

      {/* Canvas viewport */}
      <div
        ref={viewportRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        style={{
          flex: 1,
          position: 'relative',
          overflow: 'hidden',
          background: 'hsl(var(--paper))',
          cursor: 'grab',
          touchAction: 'none',
          userSelect: 'none',
        }}
      >
        {/* World transform — pan + zoom about origin. World coordinates use
            (0,0) at the band's visual center along x and at the band's top
            along y. Categories solver places around (0,0); the band is
            offset left by half its width so its midpoint sits at x=0. */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: '0 0',
            willChange: 'transform',
            pointerEvents: 'auto',
          }}
        >
          {/* Chapter band — anchored so its horizontal midpoint sits at world
              x=0; vertically occupies [0, bandHeightCells * CELL_H). */}
          <div
            style={{
              position: 'absolute',
              left: bandWorldLeft,
              top: 0,
              width: bandPxWidth,
              height: bandHeightCells * CELL_H,
            }}
          >
            <ChapterBand
              storylines={storylines}
              nodes={bookNodes}
              nodeStorylineMapping={nodeStorylineMapping}
              bandWidthCells={bandWidthCells}
              bandHeightCells={bandHeightCells}
              onNodeClick={(node, rect, opts) => {
                handleEntityClick('node', node.id, rect, opts);
              }}
              linkSourceNodeId={linkSource?.kind === 'node' ? linkSource.id : null}
            />
          </div>

          {/* Categories above + below */}
          {categoryModels.map((model) => {
            const placement = placementById.get(model.categoryId);
            if (!placement) return null;
            return (
              <CategoryBox
                key={model.categoryId}
                model={model}
                placement={placement}
                linkSourceElementId={
                  linkSource?.kind === 'element' ? linkSource.id : null
                }
                elementCardRefs={elementCardRefs}
                onElementClick={(element, rect, opts) => {
                  handleEntityClick('element', element.id, rect, opts);
                }}
                onCategoryClick={(id) => {
                  openEntity({ entityType: 'category', id });
                  close();
                }}
              />
            );
          })}

          {/* World-space edge layer. Lives INSIDE the world transform so
              edges scale + pan with everything else. SVG is sized to a
              dummy 1x1 with overflow visible so its children can extend
              into negative-x territory (top-strip categories) without
              being clipped. */}
          <svg
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: 1,
              height: 1,
              overflow: 'visible',
              pointerEvents: 'none',
            }}
          >
            {worldEdges.map((edge) => {
              const meta = EDGE_ORIGIN_META[edge.origin];
              const selected = selectedEdgeId === edge.id;
              return (
                <line
                  key={edge.id}
                  data-super-edge
                  x1={edge.x1}
                  y1={edge.y1}
                  x2={edge.x2}
                  y2={edge.y2}
                  stroke={meta.color}
                  strokeWidth={selected ? EDGE_SELECTED_WIDTH : EDGE_DEFAULT_WIDTH}
                  strokeDasharray={meta.dash ?? undefined}
                  opacity={selected ? 1 : 0.7}
                  style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedEdgeId(edge.id);
                  }}
                  onMouseEnter={(e) => {
                    if (!selected)
                      (e.currentTarget as SVGLineElement).setAttribute(
                        'stroke-width',
                        String(EDGE_HOVER_WIDTH),
                      );
                  }}
                  onMouseLeave={(e) => {
                    if (!selected)
                      (e.currentTarget as SVGLineElement).setAttribute(
                        'stroke-width',
                        String(EDGE_DEFAULT_WIDTH),
                      );
                  }}
                >
                  <title>{`${edge.fromName} → ${edge.toName}  ·  ${meta.label}`}</title>
                </line>
              );
            })}

            {/* × delete badge at the selected edge's midpoint. Bigger
                hit-target than the stroke itself so users can click it
                without precise aim. */}
            {selectedEdgeId &&
              (() => {
                const edge = worldEdges.find((e) => e.id === selectedEdgeId);
                if (!edge) return null;
                const mx = (edge.x1 + edge.x2) / 2;
                const my = (edge.y1 + edge.y2) / 2;
                return (
                  <g
                    data-super-edge-delete
                    transform={`translate(${mx}, ${my})`}
                    style={{ pointerEvents: 'auto', cursor: 'pointer' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      void deleteSelectedEdge();
                    }}
                  >
                    <circle r={9} fill="hsl(var(--paper))" stroke="hsl(var(--ink-1))" strokeWidth={1} />
                    <text
                      x={0}
                      y={1}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize={11}
                      fontFamily="var(--font-mono)"
                      fill="hsl(var(--ink-1))"
                    >
                      ×
                    </text>
                  </g>
                );
              })()}
          </svg>
        </div>

        {/* Empty-state hint when there's literally nothing to show */}
        {categoryModels.length === 0 && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: 'var(--font-serif)',
              fontStyle: 'italic',
              fontSize: 14,
              color: 'hsl(var(--ink-3))',
              pointerEvents: 'none',
            }}
          >
            no element categories yet.
          </div>
        )}
      </div>

      {/* Element popover — two-tier editor mirroring GraphView's
          NodeCardPopover. Positioned fixed so pan/zoom don't drag it. */}
      {activePopover && projectId && (() => {
        const element = bookElements.find((el) => el.id === activePopover.elementId);
        if (!element) return null;
        const category = bookElementCategories.find((c) => c.id === element.categoryId);
        const accent = category?.color ?? 'hsl(var(--ink-4))';
        return (
          <ElementCardPopover
            element={element}
            projectId={projectId}
            userId={userId}
            accentColor={accent}
            anchorRect={activePopover.anchor}
            onClose={() => setActivePopover(null)}
            onOpenInEditor={(id) => {
              setActivePopover(null);
              openEntity({ entityType: 'element', id });
              close();
            }}
          />
        );
      })()}

      {/* Pending link modal — confirms creation of a manual EntityReference
          for a shift-click pairing. Minimal because the schema has no kind
          / label fields; just identifies source + target and a confirm. */}
      {pendingLink && (() => {
        const { source, target } = pendingLink;
        const sourceName =
          source.kind === 'element'
            ? bookElements.find((e) => e.id === source.id)?.name ?? '?'
            : bookNodes.find((n) => n.id === source.id)?.title ?? '?';
        const targetName =
          target.kind === 'element'
            ? bookElements.find((e) => e.id === target.id)?.name ?? '?'
            : bookNodes.find((n) => n.id === target.id)?.title ?? '?';
        const kindLabel = (k: 'element' | 'node') => (k === 'element' ? '元素' : '章节');
        return (
          <>
            <div
              data-super-modal
              style={{
                position: 'fixed',
                inset: 0,
                background: 'hsl(var(--ink-1) / 0.18)',
                backdropFilter: 'blur(2px)',
                zIndex: 310,
              }}
              onClick={() => setPendingLink(null)}
            />
            <div
              data-super-modal
              role="dialog"
              aria-label="新建关联"
              style={{
                position: 'fixed',
                left: '50%',
                top: '50%',
                transform: 'translate(-50%, -50%)',
                width: 420,
                background: 'hsl(var(--paper))',
                border: '1px solid hsl(var(--rule))',
                borderRadius: 4,
                boxShadow: '0 8px 28px hsl(var(--ink-1) / 0.18)',
                zIndex: 311,
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <div
                style={{
                  padding: '14px 18px 8px',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  textTransform: 'uppercase',
                  letterSpacing: '0.12em',
                  color: 'hsl(var(--ink-3))',
                  borderBottom: '1px solid hsl(var(--rule))',
                }}
              >
                新建手动关联
              </div>
              <div
                style={{
                  padding: '14px 18px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  fontFamily: 'var(--font-serif)',
                  fontSize: 13,
                  color: 'hsl(var(--ink-1))',
                  lineHeight: 1.5,
                }}
              >
                <div>
                  <span style={{ color: 'hsl(var(--ink-4))', marginRight: 6 }}>
                    [{kindLabel(source.kind)}]
                  </span>
                  <strong style={{ fontWeight: 500 }}>{sourceName}</strong>
                </div>
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    color: 'hsl(var(--ink-4))',
                    letterSpacing: '0.1em',
                  }}
                >
                  ↓ 引用
                </div>
                <div>
                  <span style={{ color: 'hsl(var(--ink-4))', marginRight: 6 }}>
                    [{kindLabel(target.kind)}]
                  </span>
                  <strong style={{ fontWeight: 500 }}>{targetName}</strong>
                </div>
              </div>
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  padding: '10px 18px 14px',
                  justifyContent: 'flex-end',
                  borderTop: '1px solid hsl(var(--rule))',
                  background: 'hsl(var(--paper-deep) / 0.5)',
                }}
              >
                <button
                  type="button"
                  onClick={() => setPendingLink(null)}
                  style={{
                    border: '1px solid hsl(var(--rule))',
                    background: 'transparent',
                    color: 'hsl(var(--ink-2))',
                    padding: '4px 14px',
                    borderRadius: 3,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    textTransform: 'uppercase',
                    letterSpacing: '0.12em',
                    cursor: 'pointer',
                  }}
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void confirmPendingLink();
                  }}
                  style={{
                    border: '1px solid hsl(var(--ink-1))',
                    background: 'hsl(var(--ink-1))',
                    color: 'hsl(var(--paper))',
                    padding: '4px 14px',
                    borderRadius: 3,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    textTransform: 'uppercase',
                    letterSpacing: '0.12em',
                    cursor: 'pointer',
                  }}
                >
                  创建
                </button>
              </div>
            </div>
          </>
        );
      })()}

      {/* Drift panel — bottom-anchored, slides in. Cards are read-only
          (hover for summary); shift-click pairs with elements to create
          drift↔element manual references. */}
      {driftPanelOpen && driftNodes.length > 0 && (
        <div
          data-super-drift
          style={{
            position: 'fixed',
            left: 0,
            right: 0,
            bottom: 0,
            height: 150,
            background: 'hsl(var(--paper))',
            borderTop: '1px solid hsl(var(--rule))',
            boxShadow: '0 -4px 12px hsl(var(--ink-1) / 0.06)',
            zIndex: 260,
            display: 'flex',
            flexDirection: 'column',
            animation: 'super-drift-in 280ms cubic-bezier(0.2, 0.8, 0.2, 1)',
          }}
        >
          <style>{`
            @keyframes super-drift-in {
              from { transform: translateY(100%); }
              to   { transform: translateY(0); }
            }
          `}</style>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '6px 14px',
              borderBottom: '1px solid hsl(var(--rule) / 0.6)',
              background: 'hsl(var(--paper-deep) / 0.5)',
              flexShrink: 0,
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
              color: 'hsl(var(--ink-3))',
            }}
          >
            <span>浮缀 · {driftNodes.length}</span>
            <button
              type="button"
              onClick={() => setDriftPanelOpen(false)}
              style={{
                border: 'none',
                background: 'transparent',
                color: 'hsl(var(--ink-3))',
                cursor: 'pointer',
                fontSize: 16,
                lineHeight: 1,
                padding: '0 4px',
              }}
              title="收起"
            >
              ×
            </button>
          </div>
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflowX: 'auto',
              overflowY: 'hidden',
              padding: '10px 14px',
              display: 'flex',
              gap: 10,
            }}
          >
            {driftNodes.map((node) => {
              const isLinkSource = linkSource?.kind === 'node' && linkSource.id === node.id;
              return (
                <div
                  key={node.id}
                  data-super-card="node"
                  data-node-id={node.id}
                  ref={(el) => {
                    if (el) driftCardRefs.current.set(node.id, el);
                    else driftCardRefs.current.delete(node.id);
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    handleEntityClick('node', node.id, rect, { shiftKey: e.shiftKey });
                  }}
                  title={
                    node.summary
                      ? `${node.title || '未命名'}\n\n${node.summary}`
                      : node.title || '未命名'
                  }
                  style={{
                    flexShrink: 0,
                    width: 168,
                    height: '100%',
                    border: isLinkSource
                      ? '1.5px solid hsl(var(--ink-2))'
                      : '1px solid hsl(var(--rule))',
                    background: isLinkSource ? 'hsl(var(--paper-deep))' : 'hsl(var(--paper))',
                    outline: isLinkSource ? '2px dashed hsl(var(--ink-3))' : 'none',
                    outlineOffset: isLinkSource ? '1px' : 0,
                    borderRadius: 3,
                    padding: '8px 10px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                    cursor: 'pointer',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 8.5,
                      color: 'hsl(var(--ink-4))',
                      letterSpacing: '0.1em',
                      textTransform: 'uppercase',
                    }}
                  >
                    §{String(node.bookOrder).padStart(2, '0')}
                  </div>
                  <div
                    style={{
                      fontFamily: 'var(--font-serif)',
                      fontSize: 12,
                      fontWeight: 500,
                      color: 'hsl(var(--ink-1))',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {node.title || '未命名'}
                  </div>
                  {node.summary && (
                    <div
                      style={{
                        fontSize: 10,
                        color: 'hsl(var(--ink-3))',
                        display: '-webkit-box',
                        WebkitLineClamp: 3,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
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
        </div>
      )}

      {/* Drift edges layer — viewport-space SVG that connects drift cards
          (in the fixed bottom panel) to their linked element cards (which
          live inside the pan/zoom world). Endpoints are recomputed via
          getBoundingClientRect on every rAF tick during the slide-in
          animation, then on scroll/resize thereafter. */}
      {driftPanelOpen && driftEdgeGeom.length > 0 && (
        <svg
          style={{
            position: 'fixed',
            inset: 0,
            width: '100vw',
            height: '100vh',
            pointerEvents: 'none',
            zIndex: 259,
          }}
        >
          {driftEdgeGeom.map((edge) => {
            const meta = EDGE_ORIGIN_META[edge.origin];
            return (
              <line
                key={edge.id}
                x1={edge.x1}
                y1={edge.y1}
                x2={edge.x2}
                y2={edge.y2}
                stroke={meta.color}
                strokeWidth={1.2}
                strokeDasharray={meta.dash ?? undefined}
                opacity={0.6}
              />
            );
          })}
        </svg>
      )}
    </div>
  );
}
