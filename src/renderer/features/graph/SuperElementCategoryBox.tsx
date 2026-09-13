import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import type { BookElement } from '../../domain/book-element';
import type { LayoutPlacement } from '../../lib/super-element-layout';
import type { SuperElementCategoryModel as CategoryRenderModel } from './super-element-category-model';
import { CELL_W, CELL_H, GROUP_HEADER_PX, CATEGORY_GAP_X, cardColStep } from './super-element-metrics';

/**
 * Renders one category box at its assigned grid position. Internal layout
 * is computed in PIXELS (no dedicated header row): a fieldset-style legend
 * floats on the top border with the category name + count; named groups
 * get thin horizontal-rule strips between card rows; element cards fill
 * the rest of the surface so the box reads as "mostly cards".
 */
export interface CategoryBoxProps {
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

export const SuperElementCategoryBox = memo(CategoryBox);
