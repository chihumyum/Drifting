import { useState, useMemo, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
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
import { DriftPanel, useDriftPanelAnim } from '../../components/DriftPanel';
import { NodeCardPopover } from '../../components/graph/NodeCardPopover';

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

// Inner Y padding around the card grid inside a category box. Top padding
// leaves room for the legend-straddles-border treatment to clear the first
// card; bottom padding mirrors it for symmetry. Horizontal symmetry is
// handled directly by the card's own +3/-6 inset against its colStep, so
// no CATEGORY_INNER_PAD_X is needed (the previous 3px left-only bias was
// the reason last-column cards covered the right border).
const CATEGORY_INNER_PAD_Y_TOP = 8;
const CATEGORY_INNER_PAD_Y_BOTTOM = 4;

// Visible horizontal gap between two adjacent category boxes. Each box
// renders inset by CATEGORY_GAP_X / 2 on its left and right edges; the
// solver still reserves widthCells whole cells per box, so the layout
// math stays integer-grid. Card cells inside compress slightly (colStep
// below) so the last column doesn't overflow the visible right border.
const CATEGORY_GAP_X = CELL_W / 8;

/** Per-column horizontal pitch for cards inside a category box. The box's
 *  visible width is widthCells*CELL_W - CATEGORY_GAP_X; distributing that
 *  across widthCells columns keeps the first and last cards' inset against
 *  the box border symmetric (3px each side). */
function cardColStep(widthCells: number): number {
  return (widthCells * CELL_W - CATEGORY_GAP_X) / widthCells;
}

// Zoom range; matches the BottomTimeline expanded-scale ergonomics.
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2.0;

// Height of the always-visible BottomStatusBar — see styles/bottom-status-bar.css.
// The fullscreen overlay leaves this much room at the bottom so the status
// bar stays visible (and its drift-tab anchors above the bar).
const BSB_HEIGHT = 20;

// Inner padding inside the chapter band — kept small so storyline rows
// hug the band's top/bottom borders. The pills themselves carry a 3px
// inset against their lane edges (see pill `top = row + 3, height = CELL_H - 6`),
// which is enough breathing room without reserving a half-cell of empty
// band background. The outer gap to the nearest category strip is
// controlled separately by BAND_OUTER_PAD_PX / BAND_OUTER_RESERVE_CELLS.
const BAND_PAD_CELLS = 0.25;
const BAND_PAD_PX = (BAND_PAD_CELLS * CELL_H) / 2;

// Outer gap between the band and the nearest category strip — the band's
// visible top/bottom edges sit BAND_OUTER_PAD_PX inside the cell area the
// solver reserves. Result: ~28px of empty space above and below the band.
// Solver-side, we reserve an extra full cell of band-area; visually the
// band content offsets down by half a cell so the gap splits symmetrically.
const BAND_OUTER_PAD_PX = CELL_H / 2;
const BAND_OUTER_RESERVE_CELLS = 1;

// Breathing space around sticky-mode pan clamps. The bounds let the user
// scroll a few element-cards' worth past the band's x range and the
// category skyline's y extent — keeps the layout from feeling like it's
// caged against the viewport edges. Values are in cell units; they get
// multiplied by zoom at clamp time.
const STICKY_PAD_CELLS_X = 3;
const STICKY_PAD_CELLS_Y = 3;

// Manual EntityReference rows carry a free-form `kind` (the user category
// they choose at create time). Auto / ai-origin refs leave kind null. Color
// is hashed from the kind string so two edges of the same kind always look
// identical across renders; null-kind edges fall back to an origin-tinted
// neutral. Dash pattern always reflects origin so users can still tell at a
// glance whether a relation was authored, auto-detected, or AI-suggested.
type EdgeOrigin = 'manual' | 'auto' | 'ai';

const EDGE_ORIGIN_META: Record<EdgeOrigin, { fallbackColor: string; label: string; dash: string | null }> = {
  manual: { fallbackColor: 'hsl(var(--ink-2))', label: '手动', dash: null },
  auto: { fallbackColor: 'hsl(var(--story-4))', label: '自动', dash: '4 3' },
  ai: { fallbackColor: 'hsl(var(--story-2))', label: 'AI', dash: '1 3' },
};

const KIND_PALETTE = [
  'hsl(var(--story-1))',
  'hsl(var(--story-2))',
  'hsl(var(--story-3))',
  'hsl(var(--story-4))',
  'hsl(var(--story-5))',
  'hsl(var(--story-6))',
];
/** Stable color per kind string (djb2-ish hash, same shape as GraphView). */
function colorForKind(kind: string | null, origin: EdgeOrigin): string {
  if (!kind) return EDGE_ORIGIN_META[origin].fallbackColor;
  let h = 5381;
  for (let i = 0; i < kind.length; i++) {
    h = ((h << 5) + h) ^ kind.charCodeAt(i);
  }
  return KIND_PALETTE[Math.abs(h) % KIND_PALETTE.length];
}

/** Cubic-bezier path between two points. Control points pull straight
 *  along the y axis from each endpoint to the midline, then bend toward
 *  the opposite endpoint — produces a gentle S-curve good for crossings
 *  between the chapter band and the upper/lower category strips. */
function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  const midY = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
}

const EDGE_SELECTED_WIDTH = 2.4;
const EDGE_DEFAULT_WIDTH = 1.6;
const EDGE_HIT_WIDTH = 10;
/** Sentinel used in the filter set to represent null-kind ("uncategorised"). */
const UNCATEGORIZED_KIND = '__uncategorized__';

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
          y1: BAND_PAD_PX + rowA * CELL_H + CELL_H / 2,
          x2: slotCenterX(idxB),
          y2: BAND_PAD_PX + rowB * CELL_H + CELL_H / 2,
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
            borderBottom: idx === storylines.length - 1 ? 'none' : '1px dotted hsl(var(--rule) / 0.4)',
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

      {/* Node pills. Mirror GraphView's tile pattern: title on top, summary
          as a 2-line clamp underneath when present. Hover title attribute
          stays as a fallback so the full text is still inspectable when the
          clamp truncates. Shift-click marks the pill as a link source for
          cross-band relations. */}
      {sortedPlacedNodes.map((node, idx) => {
        const rowIdx = rowIndexByStoryline.get(node.mainStorylineId ?? '');
        if (rowIdx === undefined) return null;
        const sl = storylineById.get(node.mainStorylineId ?? '');
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
              height: CELL_H - 6,
              borderRadius: 3,
              background: isLinkSource ? 'hsl(var(--paper-deep))' : 'hsl(var(--paper))',
              border: `1px solid ${color}`,
              borderLeft: `3px solid ${color}`,
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
                fontFamily: 'var(--font-serif)',
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
              {node.title || '未命名'}
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
  // Visible box width sheds CATEGORY_GAP_X so two adjacent categories
  // sit with a small breathing gap between their borders. Cards inside
  // are compressed onto colStep so the rightmost column still clears
  // the box's right border by the same 3px the leftmost does.
  const boxPxWidth = widthCells * CELL_W - CATEGORY_GAP_X;
  const boxPxHeight = heightCells * CELL_H;
  const colStep = cardColStep(widthCells);

  return (
    <div
      style={{
        position: 'absolute',
        left: placement.gridX * CELL_W + CATEGORY_GAP_X / 2,
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
          const left = col * colStep;
          const top = g.cardRowsTopPx + rowOffset * CELL_H;
          const width = colStep;
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
  const [pendingLinkKind, setPendingLinkKind] = useState('');
  const [pendingLinkSuggestOpen, setPendingLinkSuggestOpen] = useState(false);
  // Sticky band toggle. ON = band detaches from world transform so it can
  // snap to the top/bottom viewport edge when the canvas pans past it; pan
  // and zoom are also clamped so the band's x extent always covers the
  // viewport, plus y stays within the categories' vertical extent.
  // OFF = current behaviour (band rides with world).
  const [bandSticky, setBandSticky] = useState(false);
  // Edge focus toggle. ON = only render edges whose element endpoint is
  // currently inside the viewport (and not behind the sticky band, when
  // sticky is also on). OFF = render every edge in world space, regardless
  // of visibility. Independent from bandSticky — users may want one
  // without the other.
  const [edgesViewportOnly, setEdgesViewportOnly] = useState(false);
  // Drift panel state machine + open/close helpers come from the shared
  // hook so SuperElementView and GraphView stay in sync.
  const {
    mounted: driftPanelMounted,
    open: driftPanelOpen,
    closing: driftPanelClosing,
    openPanel: openDriftPanel,
    closePanel: closeDriftPanel,
    closePanelRef: closeDriftPanelRef,
  } = useDriftPanelAnim();
  // Drift-node popover (two-tier name + summary + body editor). Mirrors the
  // popover anchor pattern used for element cards.
  const [activeDriftPopover, setActiveDriftPopover] = useState<{
    nodeId: string;
    anchor: AnchorRect;
  } | null>(null);
  // Hidden kinds — UNCATEGORIZED_KIND sentinel covers null-kind refs.
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(() => new Set());

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
      if (driftPanelMounted && !driftPanelClosing) {
        closeDriftPanelRef.current?.();
        return;
      }
      close();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [
    close,
    activePopover,
    pendingLink,
    selectedEdgeId,
    linkSource,
    driftPanelMounted,
    driftPanelClosing,
  ]);

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
  // Band height in cells: one row per storyline plus BAND_PAD_CELLS of
  // breathing space (split half above the storyline rows, half below) so
  // categories don't bump straight into the band. Empty-state minimum: 2 cells.
  const bandHeightCells = Math.max(2, storylines.length + BAND_PAD_CELLS);

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
  // Band's visible top in world coords — offset down by BAND_OUTER_PAD_PX
  // so categories above land a half-cell-equivalent above the band's visible
  // edge (and bottom-strip categories the same distance below).
  const bandTopWorldY = BAND_OUTER_PAD_PX;
  const bandWorldCenterY = bandTopWorldY + (bandHeightCells * CELL_H) / 2;

  // Solver-reserved band space — actual visible band height plus an extra
  // BAND_OUTER_RESERVE_CELLS cells so categories sit a bit further away,
  // leaving a visible gap on both sides of the band.
  const bandReservedHeightCells = bandHeightCells + BAND_OUTER_RESERVE_CELLS;
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
      bandHeightCells: bandReservedHeightCells,
      anchorX: 0, // categories cluster around world x=0 (== band center)
      searchExtent: 96,
      balanceAlpha: 1.0,
    });
  }, [categoryModels, bandReservedHeightCells]);

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
      // Mirrors CategoryBox: visible box is inset by CATEGORY_GAP_X/2 on
      // its left edge, and cards are laid out on a compressed colStep so
      // the rightmost column sits 3px shy of the visible right border.
      const boxX = placement.gridX * CELL_W + CATEGORY_GAP_X / 2;
      const boxY = placement.gridY * CELL_H;
      const colStep = cardColStep(model.widthCells);
      for (const g of model.groups) {
        g.items.forEach((el, idx) => {
          const col = idx % model.widthCells;
          const rowOffset = Math.floor(idx / model.widthCells);
          const x = boxX + col * colStep + colStep / 2;
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
      // Band top in world coords sits at bandTopWorldY (outer pad). Inside
      // the band, storyline rows are offset by BAND_PAD_PX (inner pad).
      const y = bandTopWorldY + BAND_PAD_PX + rowIdx * CELL_H + CELL_H / 2;
      m.set(n.id, { x, y });
    });
    return m;
  }, [sortedPlacedNodesAll, storylines, bandWorldLeft, bandTopWorldY]);

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
    kind: string | null;
    color: string;
    fromName: string;
    toName: string;
  };
  const worldEdges = useMemo<WorldEdge[]>(() => {
    const out: WorldEdge[] = [];
    for (const ref of manualReferences) {
      const origin = (ref.origin as EdgeOrigin) ?? 'manual';
      const kind = ref.kind ?? null;
      const filterKey = kind ?? UNCATEGORIZED_KIND;
      if (hiddenKinds.has(filterKey)) continue;
      const fromIsEl = ref.fromKind === 'element';
      const toIsEl = ref.toKind === 'element';
      const fromIsNode = ref.fromKind === 'node';
      const toIsNode = ref.toKind === 'node';
      if (!fromIsEl && !toIsEl) continue;
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
        kind,
        color: colorForKind(kind, origin),
        fromName,
        toName,
      });
    }
    return out;
  }, [
    manualReferences,
    hiddenKinds,
    elementCenters,
    nodeCenters,
    driftIds,
    bookElements,
    bookNodes,
  ]);

  // Kinds actually present in element-touching refs — drives chip rendering.
  // Includes UNCATEGORIZED_KIND when at least one ref has a null kind.
  const availableKinds = useMemo<string[]>(() => {
    const named = new Set<string>();
    let hasNull = false;
    manualReferences.forEach((r) => {
      if (!(r.fromKind === 'element' || r.toKind === 'element')) return;
      if (r.kind && r.kind.trim()) named.add(r.kind);
      else hasNull = true;
    });
    const sorted = [...named].sort();
    if (hasNull) sorted.push(UNCATEGORIZED_KIND);
    return sorted;
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
  //
  // CRITICAL: ref sync uses useLayoutEffect, NOT useEffect. The mirror layout
  // effect below (writes DOM transform from refs) runs in the same layout
  // phase as state-driven re-renders. If the refs were synced via useEffect
  // (post-paint), the mirror would read STALE refs after a state-driven
  // update — most visibly on first mount: state restores to saved pan, but
  // refs still hold the lazy-init value, so the DOM gets painted at the
  // default position and only "jumps" to the saved value after the user
  // pans (because panning starts from panRef which is then in sync).
  const panRef = useRef(pan);
  const zoomRef = useRef(zoom);
  useLayoutEffect(() => {
    panRef.current = pan;
  }, [pan]);
  useLayoutEffect(() => {
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

  // useLayoutEffect (not useEffect) so the restored viewport is committed
  // to state + DOM BEFORE the first paint. Otherwise the lazy-init position
  // (window/2 fallback) shows for one frame, looking like a brief jump.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const key = viewportStorageKey(projectId);
    if (!key) return;
    if (restoredForKey === key) return;
    let next:
      | {
          pan: { x: number; y: number };
          zoom: number;
          bandSticky?: boolean;
          edgesViewportOnly?: boolean;
        }
      | null = null;
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw) as {
          pan?: { x: number; y: number };
          zoom?: number;
          bandSticky?: boolean;
          edgesViewportOnly?: boolean;
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
            bandSticky: typeof parsed.bandSticky === 'boolean' ? parsed.bandSticky : false,
            edgesViewportOnly:
              typeof parsed.edgesViewportOnly === 'boolean' ? parsed.edgesViewportOnly : false,
          };
        }
      }
    } catch {
      /* corrupt storage — fall through to default centering */
    }
    if (!next) next = { ...initialCenter(), bandSticky: false, edgesViewportOnly: false };
    setPan(next.pan);
    setZoom(next.zoom);
    if (typeof next.bandSticky === 'boolean') setBandSticky(next.bandSticky);
    if (typeof next.edgesViewportOnly === 'boolean') setEdgesViewportOnly(next.edgesViewportOnly);
    setRestoredForKey(key);
  }, [projectId, initialCenter, restoredForKey]);

  // Save whenever pan / zoom / toggles change — but only after restore
  // has committed for the current project. localStorage writes are fast
  // enough that we don't bother debouncing pan drags.
  useEffect(() => {
    const key = viewportStorageKey(projectId);
    if (!key) return;
    if (restoredForKey !== key) return;
    try {
      localStorage.setItem(
        key,
        JSON.stringify({ pan, zoom, bandSticky, edgesViewportOnly }),
      );
    } catch {
      /* quota or privacy mode — ignore */
    }
  }, [projectId, pan, zoom, bandSticky, edgesViewportOnly, restoredForKey]);

  // Perf-critical: pan/zoom mutates a ref + the world div's style.transform
  // DIRECTLY (no setState) so cards + edges don't re-render on every
  // pointermove tick. State is committed once at gesture end so persistence
  // + derived computations (drift edge endpoints) catch up.
  const worldRef = useRef<HTMLDivElement>(null);
  // Separate band DOM node when sticky is ON — pulled out of the world so
  // its y can clamp to viewport edges independently while the world keeps
  // panning behind it.
  const bandRef = useRef<HTMLDivElement>(null);
  // Refs mirror the latest layout sizes / sticky flag so applyTransform and
  // the clamp helpers can read fresh values without bloating their dep arrays.
  const bandStickyRef = useRef(bandSticky);
  const bandWorldLeftRef = useRef(bandWorldLeft);
  const bandPxWidthRef = useRef(bandPxWidth);
  const bandHeightCellsRef = useRef(bandHeightCells);
  const bandTopWorldYRef = useRef(bandTopWorldY);
  // Cache layout's vertical bounds (in cell units) so the y clamp helper
  // below can read them without re-binding when the layout changes.
  const layoutBoundsRef = useRef(layout.bounds);
  useLayoutEffect(() => {
    bandStickyRef.current = bandSticky;
  }, [bandSticky]);
  useLayoutEffect(() => {
    bandWorldLeftRef.current = bandWorldLeft;
    bandPxWidthRef.current = bandPxWidth;
    bandHeightCellsRef.current = bandHeightCells;
    bandTopWorldYRef.current = bandTopWorldY;
  }, [bandWorldLeft, bandPxWidth, bandHeightCells, bandTopWorldY]);
  useLayoutEffect(() => {
    layoutBoundsRef.current = layout.bounds;
  }, [layout]);

  /** Sticky-mode min zoom: band must be at least as wide as the viewport
   *  so the viewport can stay fully contained in band's x range. */
  const clampZoomForSticky = useCallback((zoom: number): number => {
    if (!bandStickyRef.current || !viewportRef.current) return zoom;
    const vw = viewportRef.current.clientWidth;
    const bWidth = bandPxWidthRef.current;
    if (bWidth <= 0) return zoom;
    const minStickyZoom = vw / bWidth;
    return Math.max(minStickyZoom, zoom);
  }, []);

  /** Sticky-mode x bounds: pan.x clamped to the band's x range plus a few
   *  element-cards of breathing space on each side, so the layout doesn't
   *  feel caged against the viewport edges. */
  const clampPanXForSticky = useCallback((panX: number, zoom: number): number => {
    if (!bandStickyRef.current || !viewportRef.current) return panX;
    const vw = viewportRef.current.clientWidth;
    const bWidth = bandPxWidthRef.current;
    const bLeft = bandWorldLeftRef.current;
    if (bWidth <= 0) return panX;
    // Without pad: viewport ⊆ band in screen x.
    //   leftBand ≤ 0  →  pan.x ≤ -zoom*bLeft
    //   rightBand ≥ vw →  pan.x ≥ vw - zoom*(bLeft+bWidth)
    // With pad: allow the viewport edges to extend STICKY_PAD_CELLS_X cells
    // past the band — relaxes the hard clamp by `pad` on each side.
    const pad = STICKY_PAD_CELLS_X * CELL_W * zoom;
    const maxPanX = -zoom * bLeft + pad;
    const minPanX = vw - zoom * (bLeft + bWidth) - pad;
    if (minPanX > maxPanX) return (minPanX + maxPanX) / 2; // band narrower than viewport — center it
    return Math.max(minPanX, Math.min(maxPanX, panX));
  }, []);

  /** Sticky-mode y bounds: pan.y clamped to the category skyline's vertical
   *  extent, plus a few cards of breathing space top + bottom. */
  const clampPanYForSticky = useCallback((panY: number, zoom: number): number => {
    if (!bandStickyRef.current || !viewportRef.current) return panY;
    const vh = viewportRef.current.clientHeight;
    const bounds = layoutBoundsRef.current;
    if (!bounds) return panY;
    const minLayoutY = bounds.minY * CELL_H * zoom; // typically negative (top strip)
    const maxLayoutY = bounds.maxY * CELL_H * zoom; // positive (bottom strip)
    const layoutH = maxLayoutY - minLayoutY;
    if (layoutH <= 0) return panY;
    const pad = STICKY_PAD_CELLS_Y * CELL_H * zoom;
    if (layoutH >= vh) {
      // Tall layout — bound scroll to layout extent, with `pad` of slack.
      const maxPanY = -minLayoutY + pad; // topmost element near viewport top (+pad room)
      const minPanY = vh - maxLayoutY - pad; // bottommost near viewport bottom (+pad room)
      return Math.max(minPanY, Math.min(maxPanY, panY));
    }
    // Layout shorter than viewport — vertically center it.
    return (vh - layoutH) / 2 - minLayoutY;
  }, []);

  const applyTransform = useCallback(() => {
    const world = worldRef.current;
    if (!world) return;
    const pX = panRef.current.x;
    const pY = panRef.current.y;
    const z = zoomRef.current;
    world.style.transform = `translate(${pX}px, ${pY}px) scale(${z})`;
    // When sticky, the band rides its own transform: same x as world (so it
    // tracks the chapters horizontally), but y is clamped to viewport edges
    // when the world would scroll the band off-screen. naturalY is the
    // band's screen y under pure world transform — band's world top is
    // bandTopWorldY (outer pad), not 0.
    if (bandStickyRef.current && bandRef.current && viewportRef.current) {
      const viewportH = viewportRef.current.clientHeight;
      const bandPxH = bandHeightCellsRef.current * CELL_H * z;
      const naturalY = pY + z * bandTopWorldYRef.current;
      let bandY: number;
      if (naturalY < 0) bandY = 0;
      else if (naturalY + bandPxH > viewportH) bandY = viewportH - bandPxH;
      else bandY = naturalY;
      const bandX = pX + z * bandWorldLeftRef.current;
      bandRef.current.style.transform = `translate(${bandX}px, ${bandY}px) scale(${z})`;
    }
  }, []);

  // Mirror committed state → DOM. Runs for non-gesture updates (restore,
  // reset, initial center, sticky toggle). Gesture-time updates bypass this
  // by writing ref + DOM directly.
  useLayoutEffect(() => {
    applyTransform();
  }, [pan, zoom, bandSticky, applyTransform]);

  // When sticky flips ON, the current pan/zoom might be outside the sticky
  // bounds — clamp them in one go so the band lands inside the viewport
  // immediately rather than waiting for the user to pan/zoom.
  useLayoutEffect(() => {
    if (!bandSticky) return;
    const nextZoom = clampZoomForSticky(zoomRef.current);
    const nextPanX = clampPanXForSticky(panRef.current.x, nextZoom);
    const nextPanY = clampPanYForSticky(panRef.current.y, nextZoom);
    if (
      nextZoom !== zoomRef.current ||
      nextPanX !== panRef.current.x ||
      nextPanY !== panRef.current.y
    ) {
      zoomRef.current = nextZoom;
      panRef.current = { x: nextPanX, y: nextPanY };
      setPan(panRef.current);
      setZoom(nextZoom);
    }
  }, [bandSticky, clampPanXForSticky, clampPanYForSticky, clampZoomForSticky]);

  // Toggle data-panning on the viewport-space edge SVGs (drift edges
  // always; the sticky-band edge layer when bandSticky is on). Their CSS
  // visibility flips on this attribute so we hide them during pan/zoom
  // without re-rendering anything — recomputing viewport endpoints on
  // every frame is expensive AND the lines are momentarily wrong anyway
  // because element positions are mid-transform.
  const setPanningVisual = useCallback((panning: boolean) => {
    const layers = [driftEdgeLayerRef.current, viewportEdgeLayerRef.current];
    for (const layer of layers) {
      if (!layer) continue;
      if (panning) layer.setAttribute('data-panning', '1');
      else layer.removeAttribute('data-panning');
    }
  }, []);

  // Wheel: same gesture-ref pattern. Commit state after a brief idle so
  // persistence + drift-edge recompute don't fire on every tick.
  const wheelCommitTimerRef = useRef<number | null>(null);
  const scheduleWheelCommit = useCallback(() => {
    if (wheelCommitTimerRef.current !== null) {
      window.clearTimeout(wheelCommitTimerRef.current);
    }
    wheelCommitTimerRef.current = window.setTimeout(() => {
      wheelCommitTimerRef.current = null;
      setPan(panRef.current);
      setZoom(zoomRef.current);
      setPanningVisual(false);
      window.dispatchEvent(new Event('super-element:pan-end'));
    }, 140);
  }, [setPanningVisual]);
  useEffect(
    () => () => {
      if (wheelCommitTimerRef.current !== null) {
        window.clearTimeout(wheelCommitTimerRef.current);
      }
    },
    [],
  );

  // Native wheel listener with passive:false so preventDefault is honored.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        // ⌘/Ctrl + wheel → zoom around cursor. Trackpad pinch-zoom on
        // macOS dispatches wheel with ctrlKey=true regardless of physical
        // ⌘ state, so the same path covers both gestures.
        e.preventDefault();
        const rect = viewport.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const factor = Math.exp(-e.deltaY * 0.0015);
        const prevZoom = zoomRef.current;
        let nextZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, prevZoom * factor));
        // Sticky mode bumps the min so band-x can still cover viewport.
        nextZoom = clampZoomForSticky(nextZoom);
        if (nextZoom === prevZoom) return;
        const realFactor = nextZoom / prevZoom;
        const prevPan = panRef.current;
        // Pivot: world point under the cursor stays put.
        let nextPan = {
          x: cx - (cx - prevPan.x) * realFactor,
          y: cy - (cy - prevPan.y) * realFactor,
        };
        nextPan = {
          x: clampPanXForSticky(nextPan.x, nextZoom),
          y: clampPanYForSticky(nextPan.y, nextZoom),
        };
        panRef.current = nextPan;
        zoomRef.current = nextZoom;
      } else {
        e.preventDefault();
        const prev = panRef.current;
        const z = zoomRef.current;
        panRef.current = {
          x: clampPanXForSticky(prev.x - e.deltaX, z),
          y: clampPanYForSticky(prev.y - e.deltaY, z),
        };
      }
      applyTransform();
      setPanningVisual(true);
      scheduleWheelCommit();
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [
    applyTransform,
    scheduleWheelCommit,
    setPanningVisual,
    clampPanXForSticky,
    clampPanYForSticky,
    clampZoomForSticky,
  ]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Middle-click → always pan.
      // Left-click → pan UNLESS the target is an explicitly interactive
      // descendant (element card, edge hit-target, header button, modal,
      // …). Band node pills, category box backgrounds, group dividers,
      // and bare viewport area all count as "pannable" — that's how the
      // user gets to drag-pan from the band or empty category space.
      if (e.button !== 0 && e.button !== 1) return;
      if (e.button === 0) {
        const target = e.target as Element | null;
        if (
          target?.closest(
            // Match interactive things — these own their click/drag.
            '[data-super-card="element"]',
          ) ||
          target?.closest('[data-super-edge]') ||
          target?.closest('[data-super-edge-delete]') ||
          target?.closest('[data-super-modal]') ||
          target?.closest('button') ||
          target?.closest('a') ||
          target?.closest('input') ||
          target?.closest('textarea')
        ) {
          return;
        }
      }
      isPanningRef.current = true;
      panStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        panX: panRef.current.x,
        panY: panRef.current.y,
      };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      setPanningVisual(true);
    },
    [setPanningVisual],
  );
  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isPanningRef.current || !panStartRef.current) return;
      const start = panStartRef.current;
      const rawX = start.panX + (e.clientX - start.x);
      const rawY = start.panY + (e.clientY - start.y);
      panRef.current = {
        x: clampPanXForSticky(rawX, zoomRef.current),
        y: clampPanYForSticky(rawY, zoomRef.current),
      };
      // Direct DOM write — bypasses React reconciliation entirely. The
      // committed pan state catches up at pointerUp.
      applyTransform();
    },
    [applyTransform, clampPanXForSticky, clampPanYForSticky],
  );
  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isPanningRef.current) return;
      isPanningRef.current = false;
      panStartRef.current = null;
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* element may have lost capture mid-drag — ignore */
      }
      // Commit the latest pan to React state. Persistence + drift-edge
      // recompute fire here, exactly once per gesture.
      setPan(panRef.current);
      setPanningVisual(false);
      window.dispatchEvent(new Event('super-element:pan-end'));
    },
    [setPanningVisual],
  );

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
        setPendingLinkKind('');
        setPendingLinkSuggestOpen(false);
        setLinkSource(null);
        return;
      }
      // Plain click → open the appropriate popover.
      //   • element       → ElementCardPopover (two-tier name/summary/editor)
      //   • drift node    → NodeCardPopover (same two-tier UX, for nodes)
      //   • chapter pill  → no-op (band is read-only per design)
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
      } else if (kind === 'node' && driftIds.has(id)) {
        setActiveDriftPopover({
          nodeId: id,
          anchor: {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          },
        });
      }
    },
    [linkSource, driftIds],
  );

  // Commit a manual EntityReference for the pending link, then dismiss the
  // modal. Caller passes the modal source/target verbatim. No "kind" input
  // Commits a manual EntityReference for the pending pair. `kind` is the
  // free-form category typed in the modal (trim → null if empty). Origin
  // is always 'manual' for shift-click flow.
  const confirmPendingLink = useCallback(async () => {
    if (!pendingLink) return;
    const trimmed = pendingLinkKind.trim();
    try {
      await addRelation(
        pendingLink.source.kind,
        pendingLink.source.id,
        pendingLink.target.kind,
        pendingLink.target.id,
        { kind: trimmed || null },
      );
    } catch {
      /* surfaced through optimistic-update rollback — UI is already reverted */
    } finally {
      setPendingLink(null);
      setPendingLinkKind('');
      setPendingLinkSuggestOpen(false);
    }
  }, [pendingLink, pendingLinkKind, addRelation]);

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
  type DriftEdgeGeom = {
    id: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    origin: EdgeOrigin;
    kind: string | null;
    color: string;
  };
  const [driftEdgeGeom, setDriftEdgeGeom] = useState<DriftEdgeGeom[]>([]);
  // Tracks the panning gesture so the drift-edge SVG can be hidden without
  // triggering a React re-render of the whole tree. Toggled via direct DOM
  // class on the SVG element by the pan handlers below.
  const driftEdgeLayerRef = useRef<SVGSVGElement | null>(null);

  // Viewport-space edge layer — only used when bandSticky is ON. When the
  // band sticks to a viewport edge, world-space edges (rendered inside the
  // world transform) point to the band's NATURAL position, not its clamped
  // sticky position, so element↔node edges visually float in space. To
  // keep them honest we recompute edge endpoints in viewport coords from
  // the committed pan/zoom + sticky-clamped bandY, and render in a
  // separate fixed-position SVG. During pan, this SVG is hidden via
  // data-panning the same way drift edges are.
  type ViewportEdgeGeom = {
    id: string;
    refId: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    origin: EdgeOrigin;
    kind: string | null;
    color: string;
    fromName: string;
    toName: string;
  };
  const [viewportEdgeGeom, setViewportEdgeGeom] = useState<ViewportEdgeGeom[]>([]);
  const viewportEdgeLayerRef = useRef<SVGSVGElement | null>(null);
  useLayoutEffect(() => {
    if (!driftPanelOpen) {
      setDriftEdgeGeom([]);
      return;
    }
    let rafId = 0;
    let stop = false;
    const recompute = () => {
      const out: DriftEdgeGeom[] = [];
      for (const ref of manualReferences) {
        const origin = (ref.origin as EdgeOrigin) ?? 'manual';
        const kind = ref.kind ?? null;
        const filterKey = kind ?? UNCATEGORIZED_KIND;
        if (hiddenKinds.has(filterKey)) continue;
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
          kind,
          color: colorForKind(kind, origin),
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
    // Recompute on pan-end too: while panning we hide the SVG via ref
    // (no React re-render), then this listener catches the pan-stop event
    // and updates endpoints once.
    window.addEventListener('super-element:pan-end', onScrollOrResize);
    return () => {
      stop = true;
      cancelAnimationFrame(rafId);
      window.clearTimeout(stopTimer);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('super-element:pan-end', onScrollOrResize);
    };
  }, [driftPanelOpen, manualReferences, hiddenKinds, driftIds]);

  // ---- Viewport edge geometry (sticky mode only) ----
  // Recomputed whenever the committed pan/zoom changes (state-driven), i.e.
  // at gesture end. During pan we don't bother — the layer is hidden via
  // data-panning until the gesture ends. This effect is also retriggered
  // when sticky toggles on/off so the layer fills/empties immediately.
  useLayoutEffect(() => {
    // Viewport-space rendering runs when EITHER toggle is on:
    //   · bandSticky → endpoints need sticky-clamped band y
    //   · edgesViewportOnly → endpoints stay in world coords but we still
    //     filter by visibility, so we use the viewport SVG path anyway
    // When both off, the world-space SVG handles everything for free.
    if (!bandSticky && !edgesViewportOnly) {
      setViewportEdgeGeom([]);
      return;
    }
    if (!viewportRef.current) return;
    const z = zoom;
    const pX = pan.x;
    const pY = pan.y;
    const viewportW = viewportRef.current.clientWidth;
    const viewportH = viewportRef.current.clientHeight;
    const bandPxH = bandHeightCells * CELL_H * z;
    // Visibility check for an element endpoint — only filters when the
    // 聚焦 toggle is on. Returns false when:
    //   1. card is fully scrolled out of viewport, OR
    //   2. (with sticky also on) the card is behind the sticky band
    //      (its center y falls inside the band's clamped y range).
    // Node endpoints are always considered visible because the band itself
    // is by construction visible when sticky is on.
    const elementVisible = (x: number, y: number): boolean => {
      if (!edgesViewportOnly) return true;
      const halfW = (CELL_W * z) / 2;
      const halfH = (CELL_H * z) / 2;
      if (x + halfW < 0 || x - halfW > viewportW) return false;
      if (y + halfH < 0 || y - halfH > viewportH) return false;
      if (bandSticky && y > bandY && y < bandY + bandPxH) return false;
      return true;
    };
    // Sticky-clamped band screen y — mirrors applyTransform's logic so the
    // SVG endpoint y for any node in the band matches the band's actual
    // visible y on screen. Band's natural top in viewport is pan.y + zoom*bandTopWorldY.
    const naturalBandY = pY + z * bandTopWorldY;
    let bandY: number;
    if (naturalBandY < 0) bandY = 0;
    else if (naturalBandY + bandPxH > viewportH) bandY = viewportH - bandPxH;
    else bandY = naturalBandY;

    const out: ViewportEdgeGeom[] = [];
    for (const ref of manualReferences) {
      const origin = (ref.origin as EdgeOrigin) ?? 'manual';
      const kind = ref.kind ?? null;
      const filterKey = kind ?? UNCATEGORIZED_KIND;
      if (hiddenKinds.has(filterKey)) continue;
      const fromIsEl = ref.fromKind === 'element';
      const toIsEl = ref.toKind === 'element';
      const fromIsNode = ref.fromKind === 'node';
      const toIsNode = ref.toKind === 'node';
      if (!fromIsEl && !toIsEl) continue;
      if (fromIsNode && driftIds.has(ref.fromId)) continue;
      if (toIsNode && driftIds.has(ref.toId)) continue;
      const fromCenter = fromIsEl
        ? elementCenters.get(ref.fromId)
        : fromIsNode
          ? nodeCenters.get(ref.fromId)
          : null;
      const toCenter = toIsEl
        ? elementCenters.get(ref.toId)
        : toIsNode
          ? nodeCenters.get(ref.toId)
          : null;
      if (!fromCenter || !toCenter) continue;
      // Element endpoint screen pos: pan + zoom*world (rides world transform).
      // Node endpoint screen pos: pan.x + zoom*world.x for x (band x = world x);
      //   bandY + zoom*(world.y - bandTopWorldY) for y. The subtraction
      //   converts the node's WORLD y (which already bakes in bandTopWorldY
      //   via nodeCenters) back to band-local y, so adding bandY (the band's
      //   screen top, sticky-clamped or natural) gives the pill's true screen
      //   centre. Without the subtraction we double-count bandTopWorldY and
      //   edges land z*bandTopWorldY pixels below the pill — visible as
      //   edges terminating near the pill's bottom edge instead of its centre.
      const fromX = pX + z * fromCenter.x;
      const fromY = fromIsEl
        ? pY + z * fromCenter.y
        : bandY + z * (fromCenter.y - bandTopWorldY);
      const toX = pX + z * toCenter.x;
      const toY = toIsEl
        ? pY + z * toCenter.y
        : bandY + z * (toCenter.y - bandTopWorldY);
      // Drop edges whose element endpoint is off-screen. Nodes (sticky band)
      // always count as visible. This keeps the canvas clean when the user
      // pans to a single category — we don't want lines flying off to
      // unseen cards making the viewport feel busy.
      if (fromIsEl && !elementVisible(fromX, fromY)) continue;
      if (toIsEl && !elementVisible(toX, toY)) continue;
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
        x1: fromX,
        y1: fromY,
        x2: toX,
        y2: toY,
        origin,
        kind,
        color: colorForKind(kind, origin),
        fromName,
        toName,
      });
    }
    setViewportEdgeGeom(out);
  }, [
    bandSticky,
    edgesViewportOnly,
    pan,
    zoom,
    bandHeightCells,
    bandTopWorldY,
    manualReferences,
    hiddenKinds,
    elementCenters,
    nodeCenters,
    driftIds,
    bookElements,
    bookNodes,
  ]);

  return (
    <div
      className="super-element-overlay"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        // Stop short of the BottomStatusBar so it stays visible (and
        // clickable) underneath the super view.
        bottom: BSB_HEIGHT,
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

          {/* Kind filter chips — one per distinct kind in the project
              (plus an "未分类" chip when null-kind refs exist). Toggle
              hides matching edges across both world + drift layers. */}
          {availableKinds.map((k) => {
            const isUncat = k === UNCATEGORIZED_KIND;
            const label = isUncat ? '未分类' : k;
            // Color: hash of kind for named; ink-4 for uncategorised (mirrors
            // the default fallback used by edges with null kind + manual origin).
            const color = isUncat ? 'hsl(var(--ink-4))' : colorForKind(k, 'manual');
            const visible = !hiddenKinds.has(k);
            return (
              <button
                key={k}
                type="button"
                onClick={() =>
                  setHiddenKinds((prev) => {
                    const next = new Set(prev);
                    if (next.has(k)) next.delete(k);
                    else next.add(k);
                    return next;
                  })
                }
                title={visible ? `隐藏「${label}」` : `显示「${label}」`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  border: `1px solid ${visible ? color : 'hsl(var(--rule))'}`,
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
                  maxWidth: 140,
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
                    background: color,
                    flexShrink: 0,
                  }}
                />
                {label}
              </button>
            );
          })}

          <button
            className={`super-element-toggle${edgesViewportOnly ? ' is-on' : ''}`}
            onClick={() => setEdgesViewportOnly((v) => !v)}
            title={
              edgesViewportOnly
                ? '关闭聚焦 — 显示全部关联线'
                : '打开聚焦 — 只显示当前视口内 element 的关联线'
            }
            aria-pressed={edgesViewportOnly}
          >
            聚焦 · {edgesViewportOnly ? '开' : '关'}
          </button>
          <button
            className={`super-element-toggle${bandSticky ? ' is-on' : ''}`}
            onClick={() => setBandSticky((v) => !v)}
            title={
              bandSticky
                ? '关闭章节带粘附'
                : '打开章节带粘附 — 平移时章节带停留在视口边缘,元素从其下穿过'
            }
            aria-pressed={bandSticky}
          >
            粘带 · {bandSticky ? '开' : '关'}
          </button>
          <button
            className="super-element-reset"
            onClick={resetView}
            title="重置画布缩放与平移"
          >
            重置
          </button>
        </div>

        {/* macOS drag-region opt-out for interactive controls + reset/close
            chrome buttons. The button styles live here (instead of inline)
            so :hover can highlight them — a previous inline-style version
            shipped without :hover which left the buttons reading "dimmed
            permanently". */}
        <style>{`
          .super-element-overlay button,
          .super-element-overlay [data-super-card],
          .super-element-overlay [data-super-edge],
          .super-element-overlay [data-super-edge-delete],
          .super-element-overlay [data-super-modal],
          .super-element-overlay [data-super-drift],
          .super-element-overlay input,
          .super-element-overlay textarea { -webkit-app-region: no-drag; }

          .super-element-overlay .super-element-reset,
          .super-element-overlay .super-element-toggle {
            border: 1px solid hsl(var(--rule));
            background: transparent;
            color: hsl(var(--ink-2));
            border-radius: 3px;
            cursor: pointer;
            font-family: var(--font-mono);
            padding: 3px 10px;
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.12em;
            transition: background 120ms, color 120ms, border-color 120ms;
          }
          .super-element-overlay .super-element-reset:hover,
          .super-element-overlay .super-element-toggle:hover {
            background: hsl(var(--ink-1));
            color: hsl(var(--paper));
            border-color: hsl(var(--ink-1));
          }
          .super-element-overlay .super-element-toggle.is-on {
            background: hsl(var(--ink-1));
            color: hsl(var(--paper));
            border-color: hsl(var(--ink-1));
          }
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
        {/* World transform — pan + zoom about origin. The transform string
            is written directly via ref by pan/zoom handlers; React state
            only catches up at gesture end (see applyTransform / useLayoutEffect
            mirror above). This keeps panning at 60fps even with hundreds
            of element cards in the tree. */}
        <div
          ref={worldRef}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            transformOrigin: '0 0',
            willChange: 'transform',
            pointerEvents: 'auto',
          }}
        >
          {/* Chapter band — anchored so its horizontal midpoint sits at world
              x=0; vertically occupies [0, bandHeightCells * CELL_H). When
              the user toggles sticky on, the band is hoisted OUT of the
              world transform (rendered below as a sibling) so it can clamp
              y to the viewport edges independently. */}
          {!bandSticky && (
            <div
              style={{
                position: 'absolute',
                left: bandWorldLeft,
                top: bandTopWorldY,
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
          )}

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
              being clipped.

              When bandSticky is ON, this layer renders NOTHING — the band
              moves independently of the world transform, so any edge with
              a node endpoint would visually disconnect from the (clamped)
              node. The viewport-space edge layer below takes over in that
              case, with endpoints recomputed from the sticky-clamped band
              position. Same handover happens when 聚焦 is on — that mode
              filters edges by viewport visibility, which also needs the
              committed pan/zoom for the math. */}
          {!bandSticky && !edgesViewportOnly && (
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
              const d = edgePath(edge.x1, edge.y1, edge.x2, edge.y2);
              const kindLabel = edge.kind ?? '未分类';
              return (
                <g key={edge.id} data-super-edge>
                  {/* Invisible wide stroke for hit-testing — same trick as
                      GraphView. The visible path below sits on top and is
                      pointer-events:none so it doesn't intercept clicks. */}
                  <path
                    d={d}
                    stroke="transparent"
                    strokeWidth={EDGE_HIT_WIDTH}
                    fill="none"
                    style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedEdgeId(edge.id);
                    }}
                  >
                    <title>{`${edge.fromName} → ${edge.toName}  ·  ${kindLabel}  ·  ${meta.label}`}</title>
                  </path>
                  <path
                    d={d}
                    stroke={edge.color}
                    strokeWidth={selected ? EDGE_SELECTED_WIDTH : EDGE_DEFAULT_WIDTH}
                    strokeDasharray={meta.dash ?? undefined}
                    fill="none"
                    opacity={selected ? 1 : 0.78}
                    style={{ pointerEvents: 'none' }}
                  />
                </g>
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
          )}
        </div>

        {/* Viewport-space edge layer — rendered when EITHER 粘带 or 聚焦
            is on. Mirrors the world-space edge SVG above (path + hit-target
            + × delete badge) but with endpoints in viewport coords:
              · sticky on → node endpoint y uses the sticky-clamped band y
                so edges stay attached as the band sticks
              · 聚焦 on   → edges whose element endpoint isn't in viewport
                are dropped before rendering
            Layer is hidden via data-panning during the pan gesture; the
            state-driven useLayoutEffect above recomputes endpoints at
            gesture end. */}
        {(bandSticky || edgesViewportOnly) && (
          <svg
            ref={viewportEdgeLayerRef}
            className="super-viewport-edges"
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              pointerEvents: 'none',
              // ABOVE the sticky band (zIndex 5) so connection lines stay
              // visible even where they cross the band — matches the
              // non-sticky behaviour where the in-world edge SVG is
              // rendered after the band in DOM order and so sits on top.
              // Element cards (in the world transform, default stacking
              // context) still get hidden behind the band; edges don't.
              zIndex: 10,
            }}
          >
            <style>{`svg.super-viewport-edges[data-panning='1'] { visibility: hidden; }`}</style>
            {viewportEdgeGeom.map((edge) => {
              const meta = EDGE_ORIGIN_META[edge.origin];
              const selected = selectedEdgeId === edge.id;
              const d = edgePath(edge.x1, edge.y1, edge.x2, edge.y2);
              const kindLabel = edge.kind ?? '未分类';
              return (
                <g key={edge.id} data-super-edge>
                  <path
                    d={d}
                    stroke="transparent"
                    strokeWidth={EDGE_HIT_WIDTH}
                    fill="none"
                    style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedEdgeId(edge.id);
                    }}
                  >
                    <title>{`${edge.fromName} → ${edge.toName}  ·  ${kindLabel}  ·  ${meta.label}`}</title>
                  </path>
                  <path
                    d={d}
                    stroke={edge.color}
                    strokeWidth={selected ? EDGE_SELECTED_WIDTH : EDGE_DEFAULT_WIDTH}
                    strokeDasharray={meta.dash ?? undefined}
                    fill="none"
                    opacity={selected ? 1 : 0.78}
                    style={{ pointerEvents: 'none' }}
                  />
                </g>
              );
            })}
            {selectedEdgeId &&
              (() => {
                const sel = viewportEdgeGeom.find((e) => e.id === selectedEdgeId);
                if (!sel) return null;
                const mx = (sel.x1 + sel.x2) / 2;
                const my = (sel.y1 + sel.y2) / 2;
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
        )}

        {/* Sticky chapter band — rendered as a SIBLING of the world transform
            so its y can clamp to viewport edges independently. The transform
            is written by applyTransform() (band x tracks pan.x; band y is
            clamped). Opaque background so elements panning behind it are
            hidden — that's the "elements 被 band 吞掉" behaviour. */}
        {bandSticky && (
          <div
            ref={bandRef}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: bandPxWidth,
              height: bandHeightCells * CELL_H,
              transformOrigin: '0 0',
              willChange: 'transform',
              background: 'hsl(var(--paper))',
              zIndex: 5,
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
        )}

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
          for a shift-click pairing. Captures an optional user-defined kind
          (free-form string, with suggestions sourced from existing kinds in
          the project so terminology drifts less). */}
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
        // Distinct existing kinds (named only — never the uncategorised
        // sentinel) for the input's suggestion dropdown.
        const existingKinds = availableKinds.filter((k) => k !== UNCATEGORIZED_KIND);
        const filter = pendingLinkKind.trim().toLowerCase();
        const matches = filter
          ? existingKinds.filter((k) => k.toLowerCase().includes(filter))
          : existingKinds;
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
                width: 440,
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

              {/* Kind input + suggestions. Same shape as GraphView's
                  new-edge dialog: focus shows suggestions; mousedown on a
                  suggestion fills the input without losing focus. */}
              <div style={{ padding: '0 18px 14px' }}>
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9.5,
                    textTransform: 'uppercase',
                    letterSpacing: '0.12em',
                    color: 'hsl(var(--ink-4))',
                    marginBottom: 4,
                  }}
                >
                  分类（留空 = 未分类）
                </div>
                <div
                  style={{ position: 'relative' }}
                  onFocus={() => setPendingLinkSuggestOpen(true)}
                  onBlur={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                      setPendingLinkSuggestOpen(false);
                    }
                  }}
                >
                  <input
                    autoFocus
                    type="text"
                    value={pendingLinkKind}
                    placeholder="如：同人物 / 引用 / 时序 …"
                    onChange={(e) => setPendingLinkKind(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void confirmPendingLink();
                        return;
                      }
                      if (e.key === 'Escape') {
                        // First ESC blurs the input; central ESC handler
                        // (window-bubble) gets a second press to close.
                        e.preventDefault();
                        e.stopPropagation();
                        (e.currentTarget as HTMLInputElement).blur();
                      }
                    }}
                    style={{
                      width: '100%',
                      border: '1px solid hsl(var(--rule))',
                      borderRadius: 3,
                      padding: '6px 10px',
                      fontFamily: 'var(--font-serif)',
                      fontSize: 13,
                      color: 'hsl(var(--ink-1))',
                      background: 'hsl(var(--paper))',
                      outline: 'none',
                    }}
                  />
                  {pendingLinkSuggestOpen && matches.length > 0 && (
                    <div
                      role="listbox"
                      style={{
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        top: 'calc(100% + 4px)',
                        background: 'hsl(var(--paper))',
                        border: '1px solid hsl(var(--rule))',
                        borderRadius: 3,
                        maxHeight: 160,
                        overflowY: 'auto',
                        boxShadow: '0 4px 14px hsl(var(--ink-1) / 0.1)',
                        zIndex: 312,
                      }}
                    >
                      {matches.map((k) => (
                        <button
                          key={k}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            setPendingLinkKind(k);
                          }}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            width: '100%',
                            background: 'transparent',
                            border: 'none',
                            padding: '6px 10px',
                            cursor: 'pointer',
                            fontFamily: 'var(--font-mono)',
                            fontSize: 10,
                            color: 'hsl(var(--ink-2))',
                            letterSpacing: '0.08em',
                            textAlign: 'left',
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = 'hsl(var(--paper-deep))';
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'transparent';
                          }}
                        >
                          <span
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: 1.5,
                              background: colorForKind(k, 'manual'),
                            }}
                          />
                          {k}
                        </button>
                      ))}
                    </div>
                  )}
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

      {/* Drift bottom-affordance — shared DriftPanel shell. Cards are
          rendered inline below so the click / shift-click / popover wiring
          stays in this view's hands. */}
      {driftNodes.length > 0 && (
        <DriftPanel
          count={driftNodes.length}
          bottomOffset={BSB_HEIGHT}
          mounted={driftPanelMounted}
          open={driftPanelOpen}
          closing={driftPanelClosing}
          onOpen={openDriftPanel}
          onClose={closeDriftPanel}
        >
          {driftNodes.map((node) => {
            const isLinkSource = linkSource?.kind === 'node' && linkSource.id === node.id;
            return (
              <div
                key={node.id}
                data-super-card="node"
                data-node-id={node.id}
                className={`drift-card${isLinkSource ? ' is-link-source' : ''}`}
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
              >
                <div className="drift-card__num">
                  §{String(node.bookOrder).padStart(2, '0')}
                </div>
                <div className="drift-card__title">{node.title || '未命名'}</div>
                {node.summary && (
                  <div className="drift-card__summary">{node.summary}</div>
                )}
              </div>
            );
          })}
        </DriftPanel>
      )}

      {/* Drift edges layer — viewport-space SVG that connects drift cards
          (in the fixed bottom panel) to their linked element cards (which
          live inside the pan/zoom world). Endpoints are recomputed via
          getBoundingClientRect on every rAF tick during the slide-in
          animation, then on scroll/resize/pan-end thereafter. While the
          user is mid-pan, data-panning on the SVG hides it via CSS — no
          React re-render involved. Each edge has a halo + animated dash
          line, mirroring GraphView's drift-edge visual language. */}
      {driftPanelOpen && driftEdgeGeom.length > 0 && (
        <svg
          ref={driftEdgeLayerRef}
          className={`drift-edges${selectedEdgeId ? ' is-selected-host' : ''}`}
        >
          {driftEdgeGeom.map((edge) => {
            const d = edgePath(edge.x1, edge.y1, edge.x2, edge.y2);
            const selected = selectedEdgeId === edge.id;
            const kindLabel = edge.kind ?? '未分类';
            return (
              <g key={edge.id} className={`drift-edge${selected ? ' is-selected' : ''}`}>
                <path
                  d={d}
                  className="drift-edge__halo"
                  stroke={edge.color}
                />
                <path
                  d={d}
                  className="drift-edge__line"
                  stroke={edge.color}
                />
                <path
                  d={d}
                  className="drift-edge__hit"
                  data-super-edge
                  stroke="transparent"
                  strokeWidth={10}
                  fill="none"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedEdgeId(edge.id);
                  }}
                >
                  <title>{`${kindLabel}`}</title>
                </path>
              </g>
            );
          })}
          {selectedEdgeId &&
            (() => {
              const sel = driftEdgeGeom.find((e) => e.id === selectedEdgeId);
              if (!sel) return null;
              const mx = (sel.x1 + sel.x2) / 2;
              const my = (sel.y1 + sel.y2) / 2;
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
                  <circle r={10} fill="hsl(var(--paper))" stroke="hsl(var(--ink-1))" strokeWidth={1} />
                  <text
                    x={0}
                    y={1}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={12}
                    fontFamily="var(--font-mono)"
                    fill="hsl(var(--ink-1))"
                  >
                    ×
                  </text>
                </g>
              );
            })()}
        </svg>
      )}

      {/* Drift node popover — clicking a drift card opens the two-tier
          NodeCardPopover (same component GraphView uses), so drift nodes
          get the same name + summary + body editor flow as chapter nodes. */}
      {activeDriftPopover && projectId && (() => {
        const node = bookNodes.find((n) => n.id === activeDriftPopover.nodeId);
        if (!node) return null;
        return (
          <NodeCardPopover
            node={node}
            projectId={projectId}
            userId={userId}
            anchorRect={activeDriftPopover.anchor}
            onClose={() => setActiveDriftPopover(null)}
            onOpenInEditor={(id) => {
              setActiveDriftPopover(null);
              openEntity({ entityType: 'node', id });
              close();
            }}
          />
        );
      })()}
    </div>
  );
}
