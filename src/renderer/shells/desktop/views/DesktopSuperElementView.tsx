import { useState, useMemo, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useDataStore } from '../../../store/data-store';
import { useSuperViewNavigation } from '../../../hooks/useSuperViewNavigation';
import { useAuthStore } from '../../../store/auth';
import { useProjectNavigation } from '../../../hooks/useProjectNavigation';
import { useTimelineMarkers } from '../../../hooks/useTimelineMarkers';
import { useRelationTypePresentation } from '../../../hooks/useRelationTypePresentation';
import { useSuperViewEscapeStack } from '../../../hooks/useSuperViewEscapeStack';
import { actBoundDriftIds } from '../../../domain/book-act';
import type { BookElement, BookElementCategory } from '../../../domain/book-element';
import type { BookNode } from '../../../domain/book-node';
import { isChapter, isDrift } from '../../../domain/book-node';
import type { Storyline } from '../../../domain/storyline';
import { EntityCellContextMenu } from '../../../components/leftBars/EntityCellContextMenu';
import { useEntityCellAction } from '../../../hooks/useEntityCellAction';
import {
  solveSuperElementLayout,
  type LayoutInput,
  type LayoutPlacement,
} from '../../../lib/super-element-layout';
import { ElementCardPopover, type AnchorRect } from './ElementCardPopover';
import {
  RelationEdgePopover,
  type RelationEdgePopoverAnchor,
} from '../../../components/graph/RelationEdgePopover';
import { RelationArrowMarker } from '../../../components/graph/RelationArrowMarker';
import {
  relationArrowMarkerId,
  relationEdgePath,
} from '../../../components/graph/relation-edge-visual';
import { useEntityRelations } from '../../../usecase/useEntityRelations';
import { useEntityRelationTypes } from '../../../usecase/useEntityRelationTypes';
import { DriftPanel, useDriftPanelAnim } from '../../../components/DriftPanel';
import { NodeCardPopover } from '../../../components/graph/NodeCardPopover';
import { DesktopSuperViewHeader } from '../components/DesktopSuperViewHeader';
import { SuperViewShell } from '../../../components/SuperViewShell';
import { Button } from '../../../components/ui/Button';
import { RelationTypeField } from '../../../components/ui/RelationTypeField';
import {
  validateRelationAgainstType,
  validateRelationTypeDefinitionAgainstRelation,
} from '../../../domain/entity-relation-type';
import { RelationTypeEditor } from '../../../components/ui/RelationKindMenu';
import { defaultRelationTypeColor } from '../../../components/ui/relation-type-color';
import { ModalActions, ModalCard, ModalHeader, ModalRoot } from '../../../components/ui/Modal';
import {
  buildSuperElementCategoryModel,
  type SuperElementCategoryModel as CategoryRenderModel,
} from '../../../features/graph/super-element-category-model';
import { useSuperViewRelationUi } from '../../../features/graph/super-view-relation-ui-context';

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

const EDGE_SELECTED_WIDTH = 2.4;
const EDGE_DEFAULT_WIDTH = 1.6;
const EDGE_HIT_WIDTH = 10;
// localStorage key for the viewport (pan + zoom) per project. Restoring on
// re-entry preserves the user's mental map — they don't have to re-pan to
// the iceberg every time they pop the view.
function viewportStorageKey(projectId: string | undefined): string | null {
  if (!projectId) return null;
  return `super-element-view:viewport:${projectId}`;
}

function buildCategoryRenderModel(
  categoryId: string,
  category: BookElementCategory | null,
  elements: BookElement[],
): CategoryRenderModel {
  return buildSuperElementCategoryModel(categoryId, category, elements, {
    cellHeight: CELL_H,
    groupHeaderHeight: GROUP_HEADER_PX,
    paddingTop: CATEGORY_INNER_PAD_Y_TOP,
    paddingBottom: CATEGORY_INNER_PAD_Y_BOTTOM,
  });
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
  /** Element whose popover is open — anchor of the click-focus highlight. */
  focusedElementId?: string | null;
  /** Elements sharing an edge with the focused one — drawn highlighted. */
  connectedElementIds?: ReadonlySet<string> | null;
  /**
   * Mutable map the parent owns so it can read element-card DOM rects for
   * drift-edge geometry. Each card writes itself in on mount and removes
   * itself on unmount.
   */
  elementCardRefs?: React.MutableRefObject<Map<string, HTMLDivElement>>;
  // Per-card right-click. The parent owns the menu state so SuperElementView
  // can render a single EntityCellContextMenu at the canvas root.
  onElementContextMenu?: (
    event: React.MouseEvent,
    element: { id: string; categoryId: string | null; groupName: string | null; name: string },
  ) => void;
  onCategoryContextMenu?: (event: React.MouseEvent, categoryId: string) => void;
}

function CategoryBox({
  model,
  placement,
  onElementClick,
  onCategoryClick,
  linkSourceElementId,
  focusedElementId,
  connectedElementIds,
  elementCardRefs,
  onElementContextMenu,
  onCategoryContextMenu,
}: CategoryBoxProps) {
  const { t } = useTranslation();
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
        onContextMenu={(e) => {
          if (!onCategoryContextMenu) return;
          e.preventDefault();
          e.stopPropagation();
          onCategoryContextMenu(e, model.categoryId);
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
          {category?.name ?? t('common.untitled')}
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
          // Click-focus highlight: the popover's element + its edge
          // neighbors share the hover treatment (accent border + deep bg),
          // held while the popover is open.
          const isFocusLit =
            !isLinkSource &&
            (focusedElementId === element.id || !!connectedElementIds?.has(element.id));
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
              onContextMenu={(e) => {
                if (!onElementContextMenu) return;
                e.preventDefault();
                e.stopPropagation();
                onElementContextMenu(e, element);
              }}
              style={{
                position: 'absolute',
                left: left + 3,
                top: top + 3,
                width: width - 6,
                height: height - 6,
                border:
                  isLinkSource || isFocusLit
                    ? `1.5px solid ${accent}`
                    : '1px solid hsl(var(--rule))',
                borderRadius: 2,
                background:
                  isLinkSource || isFocusLit ? 'hsl(var(--paper-deep))' : 'hsl(var(--paper))',
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
                if (isLinkSource || isFocusLit) return;
                e.currentTarget.style.background = 'hsl(var(--paper-deep))';
                e.currentTarget.style.borderColor = accent;
              }}
              onMouseLeave={(e) => {
                if (isLinkSource || isFocusLit) return;
                e.currentTarget.style.background = 'hsl(var(--paper))';
                e.currentTarget.style.borderColor = 'hsl(var(--rule))';
              }}
            >
              <div
                style={{
                  fontFamily: 'var(--font-sans)',
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
          {t('superElement.empty.categoryEmpty')}
        </div>
      )}
    </div>
  );
}

export function DesktopSuperElementView() {
  const { t } = useTranslation();
  const { setActive: setActiveSuperView } = useSuperViewNavigation();
  const close = useCallback(() => setActiveSuperView('none'), [setActiveSuperView]);
  const { openEntity, projectId } = useProjectNavigation();
  const userId = useAuthStore((s) => s.user?.id) ?? '';
  const {
    edgeKindMeta,
    hiddenRelationTypeIds,
    setDriftPanelOpen: setSharedDriftPanelOpen,
  } = useSuperViewRelationUi('element');
  const presentRelationType = useRelationTypePresentation();

  const {
    bookElements,
    bookElementCategories,
    bookNodes,
    storylines,
    nodeStorylineMapping,
    entityRelations,
    entityRelationTypes,
    primaryStorylineByNode,
  } = useDataStore();
  const relationTypeById = useMemo(
    () => new Map(entityRelationTypes.map((type) => [type.id, type])),
    [entityRelationTypes],
  );
  const relationEndpointLabel = useCallback(
    (kind: string, id: string) => {
      if (kind === 'element') return bookElements.find((element) => element.id === id)?.name ?? '?';
      if (kind === 'node') return bookNodes.find((node) => node.id === id)?.title ?? '?';
      return '?';
    },
    [bookElements, bookNodes],
  );

  // Active popover state. Card click opens the two-tier editor; the popover
  // itself owns ESC + outside-click dismissal, but the SuperElementView ESC
  // listener below also closes it as a safety net.
  const [activePopover, setActivePopover] = useState<{
    elementId: string;
    anchor: AnchorRect;
  } | null>(null);

  // Click-focus neighborhood: while an element's popover is open, the
  // elements it shares an edge with — and those edges — light up so the
  // clicked card's graph neighborhood reads at a glance. Cleared with the
  // popover.
  const focusedElementId = activePopover?.elementId ?? null;
  const focusConnected = useMemo(() => {
    if (!focusedElementId) return null;
    const elementIds = new Set<string>();
    const edgeIds = new Set<string>();
    for (const r of entityRelations) {
      const fromHit = r.fromKind === 'element' && r.fromId === focusedElementId;
      const toHit = r.toKind === 'element' && r.toId === focusedElementId;
      if (!fromHit && !toHit) continue;
      edgeIds.add(r.id);
      if (fromHit && r.toKind === 'element') elementIds.add(r.toId);
      if (toHit && r.fromKind === 'element') elementIds.add(r.fromId);
    }
    return { elementIds, edgeIds };
  }, [focusedElementId, entityRelations]);

  // Selection / linking / drift-panel state — declared up front so the ESC
  // stack and pointer-dismiss listener below can reference them. Their
  // commit handlers (confirmPendingLink / deleteSelectedEdge) and derived
  // edge data come later, after layout is computed.
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [selectedEdgeAnchor, setSelectedEdgeAnchor] = useState<RelationEdgePopoverAnchor | null>(
    null,
  );
  const clearSelectedEdge = useCallback(() => {
    setSelectedEdgeId(null);
    setSelectedEdgeAnchor(null);
  }, []);
  const selectEdge = useCallback((id: string, clientX: number, clientY: number) => {
    setSelectedEdgeId(id);
    setSelectedEdgeAnchor({ x: clientX, y: clientY });
  }, []);
  const selectedEdgeRelation = useMemo(
    () => entityRelations.find((relation) => relation.id === selectedEdgeId) ?? null,
    [entityRelations, selectedEdgeId],
  );
  const selectedEdgeType = useMemo(
    () =>
      selectedEdgeRelation?.relationTypeId
        ? (relationTypeById.get(selectedEdgeRelation.relationTypeId) ?? null)
        : null,
    [relationTypeById, selectedEdgeRelation],
  );
  const [linkSource, setLinkSource] = useState<{ kind: 'element' | 'node'; id: string } | null>(
    null,
  );
  // Element / category card right-click menu — reuses EntityCellContextMenu
  // so the same per-entity options surface in left panel, editor top bar,
  // and here. SuperElementView-specific actions (start edge from this
  // card) come in as extras.
  const dispatchEntityAction = useEntityCellAction();
  const [contextMenu, setContextMenu] = useState<
    | {
        kind: 'element';
        x: number;
        y: number;
        elementId: string;
        elementName: string;
      }
    | {
        kind: 'category';
        x: number;
        y: number;
        categoryId: string;
      }
    | null
  >(null);
  // Drift card right-click — same EntityCellContextMenu surface as the
  // 灵感 left panel, with `startEdgeFrom` appended so users can wire a
  // drift card into an element / node from the bottom drawer.
  const [driftContextMenu, setDriftContextMenu] = useState<{
    x: number;
    y: number;
    nodeId: string;
    nodeTitle?: string;
    nodeSummary?: string;
    writingStatus: BookNode['writingStatus'];
  } | null>(null);
  const [pendingLink, setPendingLink] = useState<{
    source: { kind: 'element' | 'node'; id: string };
    target: { kind: 'element' | 'node'; id: string };
  } | null>(null);
  const [pendingLinkTypeId, setPendingLinkTypeId] = useState<string | null>(null);
  const [pendingLinkReversed, setPendingLinkReversed] = useState(false);
  const [pendingLinkCreatingType, setPendingLinkCreatingType] = useState(false);
  const closePendingLink = useCallback(() => {
    setPendingLink(null);
    setPendingLinkTypeId(null);
    setPendingLinkReversed(false);
    setPendingLinkCreatingType(false);
  }, []);
  const configuredRelationTypes = entityRelationTypes;
  const pendingLinkTypeOptions = useMemo(() => {
    if (!pendingLink) return configuredRelationTypes;
    const source = pendingLinkReversed ? pendingLink.target : pendingLink.source;
    const target = pendingLinkReversed ? pendingLink.source : pendingLink.target;
    return configuredRelationTypes.filter(
      (type) =>
        validateRelationAgainstType(type, {
          fromKind: source.kind,
          fromId: source.id,
          toKind: target.kind,
          toId: target.id,
        }).ok,
    );
  }, [configuredRelationTypes, pendingLink, pendingLinkReversed]);
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
  // hook so SuperElementView and StoryGraphView stay in sync.
  const {
    mounted: driftPanelMounted,
    open: driftPanelOpen,
    closing: driftPanelClosing,
    openPanel: openDriftPanel,
    closePanel: closeDriftPanel,
  } = useDriftPanelAnim();
  useEffect(() => {
    setSharedDriftPanelOpen(driftPanelOpen);
    return () => setSharedDriftPanelOpen(false);
  }, [driftPanelOpen, setSharedDriftPanelOpen]);
  // Drift-node popover (two-tier name + summary + body editor). Mirrors the
  // popover anchor pattern used for element cards.
  const [activeDriftPopover, setActiveDriftPopover] = useState<{
    nodeId: string;
    anchor: AnchorRect;
  } | null>(null);
  useSuperViewEscapeStack(
    [
      {
        id: `element-popover:${activePopover?.elementId ?? ''}`,
        active: activePopover !== null,
        onEscape: () => setActivePopover(null),
      },
      {
        id: `drift-popover:${activeDriftPopover?.nodeId ?? ''}`,
        active: activeDriftPopover !== null,
        onEscape: () => setActiveDriftPopover(null),
      },
      {
        id: contextMenu
          ? contextMenu.kind === 'element'
            ? `entity-menu:element:${contextMenu.elementId}`
            : `entity-menu:category:${contextMenu.categoryId}`
          : 'entity-menu',
        active: contextMenu !== null,
        onEscape: () => setContextMenu(null),
      },
      {
        id: `drift-menu:${driftContextMenu?.nodeId ?? ''}`,
        active: driftContextMenu !== null,
        onEscape: () => setDriftContextMenu(null),
      },
      {
        id: pendingLink
          ? `pending-link:${pendingLink.source.kind}:${pendingLink.source.id}:${pendingLink.target.kind}:${pendingLink.target.id}`
          : 'pending-link',
        active: pendingLink !== null,
        onEscape: closePendingLink,
      },
      {
        id: `selected-edge:${selectedEdgeId ?? ''}`,
        active: selectedEdgeId !== null,
        onEscape: clearSelectedEdge,
      },
      {
        id: linkSource ? `link-source:${linkSource.kind}:${linkSource.id}` : 'link-source',
        active: linkSource !== null,
        onEscape: () => setLinkSource(null),
      },
      {
        id: 'drift-panel',
        active: driftPanelMounted && !driftPanelClosing,
        onEscape: closeDriftPanel,
      },
    ],
    close,
  );

  // Dismiss the edge selection on any click that doesn't land on an edge or
  // its body-portaled detail surface.
  useEffect(() => {
    if (!selectedEdgeId) return;
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t) return;
      if (t.closest('[data-super-edge]') || t.closest('[data-relation-edge-popover]')) return;
      clearSelectedEdge();
    };
    document.addEventListener('pointerdown', onPointer, true);
    return () => document.removeEventListener('pointerdown', onPointer, true);
  }, [clearSelectedEdge, selectedEdgeId]);

  // ---- Build category render models (size + internal layout) ----
  // Sentinel bucket for elements with categoryId === null ("未分类").
  // Surfaced by SuperElementView as a category-less group at the tail.
  const UNCATEGORIZED_KEY = '__uncategorized__';

  const elementsByCategory = useMemo(() => {
    const m = new Map<string, BookElement[]>();
    for (const cat of bookElementCategories) m.set(cat.id, []);
    for (const el of bookElements) {
      const key = el.categoryId ?? UNCATEGORIZED_KEY;
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(el);
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
    // Two flavors of "no category":
    //   * `categoryId === null` → the new "未分类" bucket (post-trash refactor)
    //   * `categoryId === <id of a missing category>` → orphan from a stale row
    // Both render as a category-less group with category=null.
    const orphanBuckets = new Map<string, BookElement[]>();
    for (const el of bookElements) {
      const key = el.categoryId ?? UNCATEGORIZED_KEY;
      if (el.categoryId != null && known.has(el.categoryId)) continue;
      const list = orphanBuckets.get(key) ?? [];
      list.push(el);
      orphanBuckets.set(key, list);
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
  const placedNodes = useMemo(() => bookNodes.filter(isChapter), [bookNodes]);
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
      const rowIdx = rowIndex.get(primaryStorylineByNode[n.id] ?? '');
      if (rowIdx === undefined) return;
      const x = bandWorldLeft + idx * BAND_SLOT_PX + BAND_PILL_PX / 2;
      // Band top in world coords sits at bandTopWorldY (outer pad). Inside
      // the band, storyline rows are offset by BAND_PAD_PX (inner pad).
      const y = bandTopWorldY + BAND_PAD_PX + rowIdx * CELL_H + CELL_H / 2;
      m.set(n.id, { x, y });
    });
    return m;
  }, [sortedPlacedNodesAll, storylines, bandWorldLeft, bandTopWorldY, primaryStorylineByNode]);

  // Drift no longer has a bookOrder — sort by recency (matches DriftPanel).
  // Drifts BOUND to a timeline marker OR an act are excluded: they've
  // "landed" (narrative axis / act notes) and shouldn't float in the drawer
  // too. Bound-ness derives from the marker + act tables — no status flag.
  const { boundDriftIds } = useTimelineMarkers(projectId);
  const bookActs = useDataStore((s) => s.bookActs);
  const allBoundDriftIds = useMemo(() => {
    const ids = new Set(boundDriftIds);
    for (const id of actBoundDriftIds(bookActs)) ids.add(id);
    return ids;
  }, [boundDriftIds, bookActs]);
  const driftNodes = useMemo(
    () =>
      bookNodes
        .filter(isDrift)
        .filter((n) => !allBoundDriftIds.has(n.id))
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)),
    [bookNodes, allBoundDriftIds],
  );

  // ---- Reference / edge state ----
  const { addRelation, removeRelation } = useEntityRelations({
    projectId: projectId ?? '',
    userId,
  });
  const relationTypeUsecases = useEntityRelationTypes({ projectId: projectId ?? '' });
  const resolveRelationTypeColor = useCallback(
    (relationTypeId: string): string => {
      return (
        edgeKindMeta.meta[relationTypeId]?.color ??
        defaultRelationTypeColor(relationTypeId)
      );
    },
    [edgeKindMeta.meta],
  );
  const resolveRelationTypeLabel = useCallback(
    (relationTypeId: string): string => {
      const relationType = relationTypeById.get(relationTypeId);
      return relationType
        ? presentRelationType(relationType).name
        : t('relationTypes.missing');
    },
    [presentRelationType, relationTypeById, t],
  );

  // Filter & build edges sourced from the manual-reference store. v1 only
  // pulls non-inline refs (fromBlockId IS NULL — that's the store filter);
  // inline @-mention refs live in reference-index.service and aren't
  // surfaced here yet. The edge endpoints must be either element ↔ element
  // or element ↔ node (we don't render pure node ↔ node, that's StoryGraphView's
  // job). Drift-touching edges are also dropped here and rendered by the
  // viewport-space drift layer instead.
  // FULL drift set on purpose (not the panel-filtered list above): the edge
  // filters below must keep treating a marker-bound drift as a drift, or its
  // refs would leak into the world-edge layer with no position to anchor to.
  const driftIds = useMemo(() => new Set(bookNodes.filter(isDrift).map((n) => n.id)), [bookNodes]);

  type WorldEdge = {
    id: string;
    refId: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    relationTypeId: string;
    directed: boolean;
    targetInsetX: number;
    targetInsetY: number;
    color: string;
    fromName: string;
    toName: string;
  };
  const worldEdges = useMemo<WorldEdge[]>(() => {
    const out: WorldEdge[] = [];
    for (const ref of entityRelations) {
      if (hiddenRelationTypeIds.has(ref.relationTypeId)) continue;
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
        ? (bookElements.find((e) => e.id === ref.fromId)?.name ?? '?')
        : fromIsNode
          ? (bookNodes.find((n) => n.id === ref.fromId)?.title ?? '?')
          : '?';
      const toName = toIsEl
        ? (bookElements.find((e) => e.id === ref.toId)?.name ?? '?')
        : toIsNode
          ? (bookNodes.find((n) => n.id === ref.toId)?.title ?? '?')
          : '?';
      out.push({
        id: ref.id,
        refId: ref.id,
        x1: fromPt.x,
        y1: fromPt.y,
        x2: toPt.x,
        y2: toPt.y,
        relationTypeId: ref.relationTypeId,
        directed: relationTypeById.get(ref.relationTypeId)?.orientation === 'directed',
        targetInsetX: (toIsNode ? BAND_PILL_PX : CELL_W) / 2 + 6,
        targetInsetY: CELL_H / 2 + 6,
        color: resolveRelationTypeColor(ref.relationTypeId),
        fromName,
        toName,
      });
    }
    return out;
  }, [
    entityRelations,
    hiddenRelationTypeIds,
    elementCenters,
    nodeCenters,
    driftIds,
    bookElements,
    bookNodes,
    resolveRelationTypeColor,
    relationTypeById,
  ]);

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
  const touchPointsRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{
    startDistance: number;
    startZoom: number;
    worldX: number;
    worldY: number;
  } | null>(null);
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
    let next: {
      pan: { x: number; y: number };
      zoom: number;
      bandSticky?: boolean;
      edgesViewportOnly?: boolean;
    } | null = null;
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
      localStorage.setItem(key, JSON.stringify({ pan, zoom, bandSticky, edgesViewportOnly }));
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
      if (e.pointerType === 'touch') {
        const points = touchPointsRef.current;
        points.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (points.size === 2) {
          const [a, b] = [...points.values()];
          const rect = e.currentTarget.getBoundingClientRect();
          const midpoint = {
            x: (a.x + b.x) / 2 - rect.left,
            y: (a.y + b.y) / 2 - rect.top,
          };
          const startZoom = zoomRef.current;
          pinchRef.current = {
            startDistance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
            startZoom,
            worldX: (midpoint.x - panRef.current.x) / startZoom,
            worldY: (midpoint.y - panRef.current.y) / startZoom,
          };
          isPanningRef.current = false;
          panStartRef.current = null;
          for (const pointerId of points.keys()) {
            e.currentTarget.setPointerCapture(pointerId);
          }
          setPanningVisual(true);
          return;
        }
      }
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
          target?.closest('[data-relation-edge-popover]') ||
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
      e.currentTarget.setPointerCapture(e.pointerId);
      setPanningVisual(true);
    },
    [setPanningVisual],
  );
  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType === 'touch' && touchPointsRef.current.has(e.pointerId)) {
        touchPointsRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const pinch = pinchRef.current;
        if (pinch && touchPointsRef.current.size >= 2) {
          const [a, b] = [...touchPointsRef.current.values()];
          const rect = e.currentTarget.getBoundingClientRect();
          const midpoint = {
            x: (a.x + b.x) / 2 - rect.left,
            y: (a.y + b.y) / 2 - rect.top,
          };
          const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
          let nextZoom = Math.max(
            ZOOM_MIN,
            Math.min(ZOOM_MAX, pinch.startZoom * (distance / pinch.startDistance)),
          );
          nextZoom = clampZoomForSticky(nextZoom);
          panRef.current = {
            x: clampPanXForSticky(midpoint.x - pinch.worldX * nextZoom, nextZoom),
            y: clampPanYForSticky(midpoint.y - pinch.worldY * nextZoom, nextZoom),
          };
          zoomRef.current = nextZoom;
          applyTransform();
          e.preventDefault();
          return;
        }
      }
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
    [applyTransform, clampPanXForSticky, clampPanYForSticky, clampZoomForSticky],
  );
  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType === 'touch') {
        const points = touchPointsRef.current;
        points.delete(e.pointerId);
        if (pinchRef.current) {
          pinchRef.current = null;
          setPan(panRef.current);
          setZoom(zoomRef.current);
          setPanningVisual(false);
          window.dispatchEvent(new Event('super-element:pan-end'));
          const remaining = [...points.values()][0];
          if (remaining) {
            isPanningRef.current = true;
            panStartRef.current = {
              x: remaining.x,
              y: remaining.y,
              panX: panRef.current.x,
              panY: panRef.current.y,
            };
            setPanningVisual(true);
          } else {
            isPanningRef.current = false;
            panStartRef.current = null;
          }
          try {
            e.currentTarget.releasePointerCapture(e.pointerId);
          } catch {
            /* pointer capture may already be gone */
          }
          return;
        }
      }
      if (!isPanningRef.current) return;
      isPanningRef.current = false;
      panStartRef.current = null;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
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
    (kind: 'element' | 'node', id: string, rect: DOMRect, opts: { shiftKey: boolean }) => {
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
        setPendingLinkTypeId(null);
        setPendingLinkReversed(false);
        setPendingLinkCreatingType(false);
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

  // Commit a typed entity relation for the pending pair. The modal either
  // selects an existing compatible definition or creates one in place; every
  // shift-click relation remains a manual-origin write.
  const confirmPendingLink = useCallback(async () => {
    if (!pendingLink || !pendingLinkTypeId) return;
    const source = pendingLinkReversed ? pendingLink.target : pendingLink.source;
    const target = pendingLinkReversed ? pendingLink.source : pendingLink.target;
    try {
      await addRelation(source.kind, source.id, target.kind, target.id, {
        relationTypeId: pendingLinkTypeId,
      });
    } catch {
      /* surfaced through optimistic-update rollback — UI is already reverted */
    } finally {
      closePendingLink();
    }
  }, [pendingLink, pendingLinkReversed, pendingLinkTypeId, addRelation, closePendingLink]);

  const deleteSelectedEdge = useCallback(async () => {
    if (!selectedEdgeId) return;
    const id = selectedEdgeId;
    clearSelectedEdge();
    try {
      await removeRelation(id);
    } catch {
      /* rollback handles UI; nothing to undo here */
    }
  }, [clearSelectedEdge, selectedEdgeId, removeRelation]);

  // ---- Drift edges (viewport-space) ----
  // Drift node cards live in the bottom panel (position: fixed, NOT in the
  // world transform), so the SVG that connects drift cards to their linked
  // elements has to be in viewport coordinates. We measure both endpoints
  // via getBoundingClientRect on each animation frame while the panel is
  // mounted — same recipe as StoryGraphView.
  const driftCardRefs = useRef(new Map<string, HTMLDivElement>());
  const elementCardRefs = useRef(new Map<string, HTMLDivElement>());
  type DriftEdgeGeom = {
    id: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    relationTypeId: string;
    directed: boolean;
    targetInsetX: number;
    targetInsetY: number;
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
    relationTypeId: string;
    directed: boolean;
    targetInsetX: number;
    targetInsetY: number;
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
      for (const ref of entityRelations) {
        if (hiddenRelationTypeIds.has(ref.relationTypeId)) continue;
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
        const driftRect = driftEl.getBoundingClientRect();
        const elementRect = elEl.getBoundingClientRect();
        const fromRect = fromIsDriftNode ? driftRect : elementRect;
        const toRect = toIsDriftNode ? driftRect : elementRect;
        out.push({
          id: ref.id,
          x1: fromRect.left + fromRect.width / 2,
          y1: fromRect.top + fromRect.height / 2,
          x2: toRect.left + toRect.width / 2,
          y2: toRect.top + toRect.height / 2,
          relationTypeId: ref.relationTypeId,
          directed: relationTypeById.get(ref.relationTypeId)?.orientation === 'directed',
          targetInsetX: toRect.width / 2 + 6,
          targetInsetY: toRect.height / 2 + 6,
          color: resolveRelationTypeColor(ref.relationTypeId),
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
  }, [
    driftPanelOpen,
    entityRelations,
    hiddenRelationTypeIds,
    driftIds,
    resolveRelationTypeColor,
    relationTypeById,
  ]);

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
    for (const ref of entityRelations) {
      if (hiddenRelationTypeIds.has(ref.relationTypeId)) continue;
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
      const fromY = fromIsEl ? pY + z * fromCenter.y : bandY + z * (fromCenter.y - bandTopWorldY);
      const toX = pX + z * toCenter.x;
      const toY = toIsEl ? pY + z * toCenter.y : bandY + z * (toCenter.y - bandTopWorldY);
      // Drop edges whose element endpoint is off-screen. Nodes (sticky band)
      // always count as visible. This keeps the canvas clean when the user
      // pans to a single category — we don't want lines flying off to
      // unseen cards making the viewport feel busy.
      if (fromIsEl && !elementVisible(fromX, fromY)) continue;
      if (toIsEl && !elementVisible(toX, toY)) continue;
      const fromName = fromIsEl
        ? (bookElements.find((e) => e.id === ref.fromId)?.name ?? '?')
        : fromIsNode
          ? (bookNodes.find((n) => n.id === ref.fromId)?.title ?? '?')
          : '?';
      const toName = toIsEl
        ? (bookElements.find((e) => e.id === ref.toId)?.name ?? '?')
        : toIsNode
          ? (bookNodes.find((n) => n.id === ref.toId)?.title ?? '?')
          : '?';
      out.push({
        id: ref.id,
        refId: ref.id,
        x1: fromX,
        y1: fromY,
        x2: toX,
        y2: toY,
        relationTypeId: ref.relationTypeId,
        directed: relationTypeById.get(ref.relationTypeId)?.orientation === 'directed',
        targetInsetX: ((toIsNode ? BAND_PILL_PX : CELL_W) / 2 + 6) * z,
        targetInsetY: (CELL_H / 2 + 6) * z,
        color: resolveRelationTypeColor(ref.relationTypeId),
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
    entityRelations,
    hiddenRelationTypeIds,
    elementCenters,
    nodeCenters,
    driftIds,
    bookElements,
    bookNodes,
    resolveRelationTypeColor,
    relationTypeById,
  ]);

  return (
    <SuperViewShell className="super-element-overlay">
      {/* Header — back + Super tabs + stats + filter controls. */}
      <DesktopSuperViewHeader
        meta={t('superElement.meta', {
          categories: bookElementCategories.length,
          elements: bookElements.length,
        })}
        onBack={close}
        rightSlot={
          <>
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
                {t('superElement.linkHint')}
              </div>
            )}

            <button
              className={`super-element-toggle${edgesViewportOnly ? ' is-on' : ''}`}
              onClick={() => setEdgesViewportOnly((v) => !v)}
              title={
                edgesViewportOnly ? t('superElement.focusOffTitle') : t('superElement.focusOnTitle')
              }
              aria-pressed={edgesViewportOnly}
            >
              {t('superElement.focusToggle', {
                state: edgesViewportOnly ? t('superElement.stateOn') : t('superElement.stateOff'),
              })}
            </button>
            <button
              className={`super-element-toggle${bandSticky ? ' is-on' : ''}`}
              onClick={() => setBandSticky((v) => !v)}
              title={
                bandSticky ? t('superElement.stickyOffTitle') : t('superElement.stickyOnTitle')
              }
              aria-pressed={bandSticky}
            >
              {t('superElement.stickyToggle', {
                state: bandSticky ? t('superElement.stateOn') : t('superElement.stateOff'),
              })}
            </button>
            <button
              className="super-element-reset"
              onClick={resetView}
              title={t('superElement.resetTitle')}
            >
              {t('superElement.reset')}
            </button>
          </>
        }
      />

      {/* Canvas viewport. `.super-view-body` keeps it aligned with the shared
          flat full-screen shell. The position:absolute child (`worldRef`) is
          unaffected by the class's `display: flex` since it's out of flow. */}
      <div
        ref={viewportRef}
        className="super-view-body"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
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
                primaryStorylineByNode={primaryStorylineByNode}
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
                linkSourceElementId={linkSource?.kind === 'element' ? linkSource.id : null}
                focusedElementId={focusedElementId}
                connectedElementIds={focusConnected?.elementIds ?? null}
                elementCardRefs={elementCardRefs}
                onElementClick={(element, rect, opts) => {
                  handleEntityClick('element', element.id, rect, opts);
                }}
                onCategoryClick={(id) => {
                  openEntity({ entityType: 'category', id });
                  close();
                }}
                onElementContextMenu={(event, element) => {
                  setContextMenu({
                    kind: 'element',
                    x: event.clientX + 2,
                    y: event.clientY - 2,
                    elementId: element.id,
                    elementName: element.name,
                  });
                }}
                onCategoryContextMenu={(event, categoryId) => {
                  setContextMenu({
                    kind: 'category',
                    x: event.clientX + 2,
                    y: event.clientY - 2,
                    categoryId,
                  });
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
                // Click-focus: edges touching the popover's element render at
                // selected strength so the lit neighborhood includes its links.
                const selected =
                  selectedEdgeId === edge.id || !!focusConnected?.edgeIds.has(edge.id);
                const markerId = relationArrowMarkerId('super-world-arrow', edge.id);
                const d = relationEdgePath({
                  x1: edge.x1,
                  y1: edge.y1,
                  x2: edge.x2,
                  y2: edge.y2,
                  directed: edge.directed,
                  targetInsetX: edge.targetInsetX,
                  targetInsetY: edge.targetInsetY,
                });
                const typeLabel = resolveRelationTypeLabel(edge.relationTypeId);
                return (
                  <g key={edge.id} data-super-edge>
                    {edge.directed && (
                      <defs>
                        <RelationArrowMarker id={markerId} color={edge.color} />
                      </defs>
                    )}
                    {/* Invisible wide stroke for hit-testing — same trick as
                      StoryGraphView. The visible path below sits on top and is
                      pointer-events:none so it doesn't intercept clicks. */}
                    <path
                      d={d}
                      stroke="transparent"
                      strokeWidth={EDGE_HIT_WIDTH}
                      fill="none"
                      style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                      onClick={(e) => {
                        e.stopPropagation();
                        selectEdge(edge.id, e.clientX, e.clientY);
                      }}
                    >
                      <title>{`${edge.fromName} → ${edge.toName}  ·  ${typeLabel}`}</title>
                    </path>
                    <path
                      d={d}
                      stroke={edge.color}
                      strokeWidth={selected ? EDGE_SELECTED_WIDTH : EDGE_DEFAULT_WIDTH}
                      fill="none"
                      opacity={selected ? 1 : 0.78}
                      markerEnd={edge.directed ? `url(#${markerId})` : undefined}
                      style={{ pointerEvents: 'none' }}
                    />
                  </g>
                );
              })}
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
            {viewportEdgeGeom.map((edge) => {
              // Same click-focus boost as the world-space layer above.
              const selected = selectedEdgeId === edge.id || !!focusConnected?.edgeIds.has(edge.id);
              const markerId = relationArrowMarkerId('super-viewport-arrow', edge.id);
              const d = relationEdgePath({
                x1: edge.x1,
                y1: edge.y1,
                x2: edge.x2,
                y2: edge.y2,
                directed: edge.directed,
                targetInsetX: edge.targetInsetX,
                targetInsetY: edge.targetInsetY,
              });
              const typeLabel = resolveRelationTypeLabel(edge.relationTypeId);
              return (
                <g key={edge.id} data-super-edge>
                  {edge.directed && (
                    <defs>
                      <RelationArrowMarker id={markerId} color={edge.color} />
                    </defs>
                  )}
                  <path
                    d={d}
                    stroke="transparent"
                    strokeWidth={EDGE_HIT_WIDTH}
                    fill="none"
                    style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      selectEdge(edge.id, e.clientX, e.clientY);
                    }}
                  >
                    <title>{`${edge.fromName} → ${edge.toName}  ·  ${typeLabel}`}</title>
                  </path>
                  <path
                    d={d}
                    stroke={edge.color}
                    strokeWidth={selected ? EDGE_SELECTED_WIDTH : EDGE_DEFAULT_WIDTH}
                    fill="none"
                    opacity={selected ? 1 : 0.78}
                    markerEnd={edge.directed ? `url(#${markerId})` : undefined}
                    style={{ pointerEvents: 'none' }}
                  />
                </g>
              );
            })}
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
              primaryStorylineByNode={primaryStorylineByNode}
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
              fontFamily: 'var(--font-sans)',
              fontStyle: 'italic',
              fontSize: 14,
              color: 'hsl(var(--ink-3))',
              pointerEvents: 'none',
            }}
          >
            {t('superElement.empty.noCategories')}
          </div>
        )}
      </div>

      {/* Element popover — two-tier editor mirroring StoryGraphView's
          NodeCardPopover. Positioned fixed so pan/zoom don't drag it. */}
      {activePopover &&
        projectId &&
        (() => {
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

      {/* Pending link modal — confirms a typed, direction-aware relation for
          a shift-click pairing. */}
      {pendingLink &&
        (() => {
          const { source, target } = pendingLink;
          const sourceName =
            source.kind === 'element'
              ? (bookElements.find((e) => e.id === source.id)?.name ?? '?')
              : (bookNodes.find((n) => n.id === source.id)?.title ?? '?');
          const targetName =
            target.kind === 'element'
              ? (bookElements.find((e) => e.id === target.id)?.name ?? '?')
              : (bookNodes.find((n) => n.id === target.id)?.title ?? '?');
          const kindLabel = (k: 'element' | 'node') =>
            k === 'element' ? t('superElement.kind.element') : t('superElement.kind.chapter');
          return (
            <ModalRoot onClose={closePendingLink} ariaLabel={t('storyGraph.edge.newTitle')}>
              <ModalCard
                width={pendingLinkCreatingType ? 560 : 440}
                className="relation-type-create-modal"
              >
                <ModalHeader
                  title={t('superElement.manualRelationTitle')}
                  onClose={closePendingLink}
                  closeLabel={t('common.close')}
                />
                <div
                  style={{
                    padding: '14px 18px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    fontFamily: 'var(--font-sans)',
                    fontSize: 13,
                    color: 'hsl(var(--ink-1))',
                    lineHeight: 1.5,
                  }}
                >
                  <div>
                    <span style={{ color: 'hsl(var(--ink-4))', marginRight: 6 }}>
                      [{kindLabel(pendingLinkReversed ? target.kind : source.kind)}]
                    </span>
                    <strong style={{ fontWeight: 500 }}>
                      {pendingLinkReversed ? targetName : sourceName}
                    </strong>
                  </div>
                  <div
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10,
                      color: 'hsl(var(--ink-4))',
                      letterSpacing: '0.1em',
                    }}
                  >
                    <button
                      type="button"
                      className="relation-endpoint-swap"
                      onClick={() => {
                        setPendingLinkReversed((value) => !value);
                        setPendingLinkTypeId(null);
                        setPendingLinkCreatingType(false);
                      }}
                    >
                      ⇄ {t('superElement.relationVerb')}
                    </button>
                  </div>
                  <div>
                    <span style={{ color: 'hsl(var(--ink-4))', marginRight: 6 }}>
                      [{kindLabel(pendingLinkReversed ? source.kind : target.kind)}]
                    </span>
                    <strong style={{ fontWeight: 500 }}>
                      {pendingLinkReversed ? sourceName : targetName}
                    </strong>
                  </div>
                </div>

                {/* Kind input + suggestions. Same shape as StoryGraphView's
                  new-edge dialog: focus shows suggestions; mousedown on a
                  suggestion fills the input without losing focus. */}
                <div style={{ padding: '0 18px 14px' }}>
                  <div className="relation-type-modal__heading">
                    <div
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 9.5,
                        textTransform: 'uppercase',
                        letterSpacing: '0.12em',
                        color: 'hsl(var(--ink-4))',
                      }}
                    >
                      {t('storyGraph.edge.kindLabel')}
                    </div>
                    <button
                      type="button"
                      className="relation-type-modal__create"
                      onClick={() => setPendingLinkCreatingType((value) => !value)}
                    >
                      {pendingLinkCreatingType
                        ? t('relationTypes.chooseExisting')
                        : `＋ ${t('relationTypes.createInline')}`}
                    </button>
                  </div>
                  {pendingLinkCreatingType ? (
                    <RelationTypeEditor
                      key={`${source.kind}:${target.kind}:${pendingLinkReversed ? 'reversed' : 'forward'}`}
                      initialSourceKinds={[pendingLinkReversed ? target.kind : source.kind]}
                      initialTargetKinds={[pendingLinkReversed ? source.kind : target.kind]}
                      onCancel={() => setPendingLinkCreatingType(false)}
                      onSave={async (definition) => {
                        const checked = validateRelationTypeDefinitionAgainstRelation(definition, {
                          fromKind: pendingLinkReversed ? target.kind : source.kind,
                          fromId: pendingLinkReversed ? target.id : source.id,
                          toKind: pendingLinkReversed ? source.kind : target.kind,
                          toId: pendingLinkReversed ? source.id : target.id,
                        });
                        if (!checked.ok) throw new Error(checked.message);
                        const created = await relationTypeUsecases.createRelationType(definition);
                        setPendingLinkTypeId(created.id);
                        setPendingLinkCreatingType(false);
                      }}
                    />
                  ) : (
                    <RelationTypeField
                      autoFocus
                      value={pendingLinkTypeId}
                      onChange={setPendingLinkTypeId}
                      options={pendingLinkTypeOptions}
                      resolveOptionColor={resolveRelationTypeColor}
                      placeholder={t('storyGraph.edge.kindPlaceholder')}
                      ariaLabel={t('storyGraph.edge.kindLabel')}
                      buttonClassName="relation-type-field__button relation-type-field__button--full"
                    />
                  )}
                </div>
                <ModalActions>
                  <Button onClick={closePendingLink} variant="default" size="sm">
                    {t('common.cancel')}
                  </Button>
                  <Button
                    disabled={!pendingLinkTypeId}
                    onClick={() => {
                      void confirmPendingLink();
                    }}
                    variant="primary"
                    size="sm"
                  >
                    {t('storyGraph.edge.create')}
                  </Button>
                </ModalActions>
              </ModalCard>
            </ModalRoot>
          );
        })()}

      {/* Drift bottom-affordance — shared DriftPanel shell. Cards are
          rendered inline below so the click / shift-click / popover wiring
          stays in this view's hands. */}
      {driftNodes.length > 0 && (
        <DriftPanel
          count={driftNodes.length}
          mounted={driftPanelMounted}
          open={driftPanelOpen}
          closing={driftPanelClosing}
          onOpen={openDriftPanel}
          onClose={closeDriftPanel}
        >
          {driftNodes.map((node) => {
            const isLinkSource = linkSource?.kind === 'node' && linkSource.id === node.id;
            const isResting = node.writingStatus === 'resting';
            return (
              <div
                key={node.id}
                data-super-card="node"
                data-node-id={node.id}
                className={`drift-card${isLinkSource ? ' is-link-source' : ''}${isResting ? ' is-resting' : ''}`}
                ref={(el) => {
                  if (el) driftCardRefs.current.set(node.id, el);
                  else driftCardRefs.current.delete(node.id);
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  handleEntityClick('node', node.id, rect, { shiftKey: e.shiftKey });
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setDriftContextMenu({
                    x: e.clientX + 2,
                    y: e.clientY - 2,
                    nodeId: node.id,
                    nodeTitle: node.title ?? undefined,
                    nodeSummary: node.summary ?? undefined,
                    writingStatus: node.writingStatus,
                  });
                }}
                title={
                  node.summary
                    ? `${node.title || t('common.untitled')}\n\n${node.summary}`
                    : node.title || t('common.untitled')
                }
              >
                <div className="drift-card__num">§{String(node.bookOrder).padStart(2, '0')}</div>
                <div className="drift-card__title">{node.title || t('common.untitled')}</div>
                {node.summary && <div className="drift-card__summary">{node.summary}</div>}
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
          line, mirroring StoryGraphView's drift-edge visual language. */}
      {driftPanelOpen && driftEdgeGeom.length > 0 && (
        <svg
          ref={driftEdgeLayerRef}
          className={`drift-edges${selectedEdgeId ? ' is-selected-host' : ''}`}
        >
          {driftEdgeGeom.map((edge) => {
            const markerId = relationArrowMarkerId('super-drift-arrow', edge.id);
            const d = relationEdgePath({
              x1: edge.x1,
              y1: edge.y1,
              x2: edge.x2,
              y2: edge.y2,
              directed: edge.directed,
              targetInsetX: edge.targetInsetX,
              targetInsetY: edge.targetInsetY,
            });
            const selected = selectedEdgeId === edge.id;
            const typeLabel = resolveRelationTypeLabel(edge.relationTypeId);
            return (
              <g key={edge.id} className={`drift-edge${selected ? ' is-selected' : ''}`}>
                {edge.directed && (
                  <defs>
                    <RelationArrowMarker id={markerId} color={edge.color} />
                  </defs>
                )}
                <path d={d} className="drift-edge__halo" stroke={edge.color} />
                <path
                  d={d}
                  className="drift-edge__line"
                  stroke={edge.color}
                  markerEnd={edge.directed ? `url(#${markerId})` : undefined}
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
                    selectEdge(edge.id, e.clientX, e.clientY);
                  }}
                >
                  <title>{typeLabel}</title>
                </path>
              </g>
            );
          })}
        </svg>
      )}

      {selectedEdgeAnchor && selectedEdgeRelation && selectedEdgeType && (
        <RelationEdgePopover
          anchor={selectedEdgeAnchor}
          relation={selectedEdgeRelation}
          relationType={selectedEdgeType}
          sourceLabel={relationEndpointLabel(
            selectedEdgeRelation.fromKind,
            selectedEdgeRelation.fromId,
          )}
          targetLabel={relationEndpointLabel(
            selectedEdgeRelation.toKind,
            selectedEdgeRelation.toId,
          )}
          color={resolveRelationTypeColor(selectedEdgeRelation.relationTypeId)}
          onDelete={() => {
            void deleteSelectedEdge();
          }}
        />
      )}

      {/* Drift node popover — clicking a drift card opens the two-tier
          NodeCardPopover (same component StoryGraphView uses), so drift nodes
          get the same name + summary + body editor flow as chapter nodes. */}
      {activeDriftPopover &&
        projectId &&
        (() => {
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

      {contextMenu?.kind === 'element' &&
        (() => {
          const el = bookElements.find((e) => e.id === contextMenu.elementId);
          const category =
            el?.categoryId != null
              ? (bookElementCategories.find((c) => c.id === el.categoryId) ?? null)
              : null;
          const tags: Array<{ id: string; name: string; color?: string | null }> = [];
          if (category) {
            tags.push({
              id: `cat-${category.id}`,
              name: category.name || t('superElement.unnamedCategory'),
              color: category.color,
            });
          } else if (el && el.categoryId == null) {
            tags.push({
              id: 'cat-none',
              name: t('superElement.uncategorized'),
              color: 'hsl(var(--ink-4))',
            });
          }
          const groupName = el?.groupName?.trim();
          if (groupName) {
            tags.push({ id: `grp-${groupName}`, name: groupName, color: 'hsl(var(--ink-4))' });
          }
          return (
            <EntityCellContextMenu
              x={contextMenu.x}
              y={contextMenu.y}
              editorType="element"
              header={{
                title: contextMenu.elementName,
                subtitle: el?.summary ?? undefined,
                tags,
              }}
              extraGroups={[
                [{ action: 'startEdgeFrom', label: t('superElement.startEdgeFromElement') }],
              ]}
              onAction={(action) => {
                const eid = contextMenu.elementId;
                if (action === 'startEdgeFrom') {
                  setLinkSource({ kind: 'element', id: eid });
                  return;
                }
                void dispatchEntityAction({ entityType: 'element', id: eid, action });
              }}
              onClose={() => setContextMenu(null)}
            />
          );
        })()}
      {contextMenu?.kind === 'category' && (
        <EntityCellContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          editorType="category"
          onAction={(action) => {
            void dispatchEntityAction({
              entityType: 'category',
              id: contextMenu.categoryId,
              action,
            });
          }}
          onClose={() => setContextMenu(null)}
        />
      )}
      {driftContextMenu && (
        <EntityCellContextMenu
          x={driftContextMenu.x}
          y={driftContextMenu.y}
          editorType="node"
          nodeStatusKind="drift"
          nodeWritingStatus={driftContextMenu.writingStatus}
          header={{
            title: driftContextMenu.nodeTitle,
            subtitle: driftContextMenu.nodeSummary,
          }}
          extraGroups={[[{ action: 'startEdgeFrom', label: t('superElement.startEdgeFromDrift') }]]}
          onAction={(action) => {
            const nid = driftContextMenu.nodeId;
            if (action === 'startEdgeFrom') {
              setLinkSource({ kind: 'node', id: nid });
              return;
            }
            void dispatchEntityAction({ entityType: 'node', id: nid, action });
          }}
          onClose={() => setDriftContextMenu(null)}
        />
      )}
    </SuperViewShell>
  );
}
