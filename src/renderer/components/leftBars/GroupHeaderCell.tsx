import type { MouseEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { AgentCountBadge } from './AgentCountBadge';
import { AgentChangeIndicator } from './AgentChangeIndicator';
import { SandCell } from '../ui/SandCell';
import { BrushIcon } from '../ui/BrushIcon';

// Single source for the left-sidebar group-header cell. Label headers keep
// the ordinary [chevron] [mark] row; compact Element categories opt into a
// frame mode whose legend sits in the top edge of their sand frame.
// A storyline heading is a cell of its own (`variant="cell"`): its sand dash
// at the start, its name, and the chevron at the end; it answers hover and
// selection exactly like the chapter cells under it (SandCell).
//
// The component is purely presentational — it doesn't own collapse or
// add-affordance state, just renders the chrome and forwards the toggles.
// Hover-only actions are scoped to this header itself. That prevents hovering
// a parent group from revealing add buttons in every nested descendant.

/** A storyline heading sits further left than its chapters' seals. */
const GROUP_CELL_PAD_LEFT = 4;

export interface GroupHeaderCellProps {
  name: string;
  count: number;
  /** Hide the ordinary total while retaining Agent activity in the count slot. */
  showTotalCount?: boolean;
  color: string;
  // Optional leading glyph rendered IN PLACE OF the color dot (e.g. a folder
  // icon for drift groups, to set them apart from the category color dot).
  // When omitted the color dot shows as before.
  glyph?: ReactNode;
  // The kind mark of an openable group (KindMark), in place of the color dot.
  mark?: ReactNode;
  variant?: 'label' | 'cell';
  // Cell variant: this group's own tab is the active editor.
  selected?: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  collapseDisabled?: boolean;
  // Element compact-index categories are boxed in a sand frame of their
  // colour (CSS), the heading set into its top edge: [corner mark] [name]
  // [count] [chevron]. The label remains an editor link; the chevron owns
  // disclosure, and collapsing lets the frame fade out.
  collapseChrome?: 'chevron' | 'frame';
  // Whole-row click — typically "open this group's entity editor".
  onClick?: () => void;
  onDoubleClick?: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
  onPreviewEnter?: (anchor: HTMLElement) => void;
  onPreviewLeave?: () => void;
  // Title shown as the + button tooltip. When omitted, the + button is
  // skipped entirely (useful for read-only group headers).
  addButtonTitle?: string;
  onAdd?: (event: MouseEvent<HTMLButtonElement>) => void;
  addButtonHasPopup?: 'menu' | 'dialog';
  addButtonExpanded?: boolean;
  addButtonVisibility?: 'hover' | 'always';
  // Optional sticky positioning for headers that should stay visible while
  // the user scrolls their group's body (ElementPanel category headers do
  // this so the group label remains in view).
  sticky?: boolean;
  // Semantic group surfaces may tint the sticky slab while preserving the
  // shared header geometry. Omitted callers keep the ordinary chrome plane.
  stickyBackground?: string;
  // Optional inline action rendered after the count and before the primary +.
  rightExtra?: ReactNode;
  // Agent activity bubbled up from this group's child cells (#17). While a child
  // is busy the color dot blinks accent; once the run finishes and leaves
  // unviewed changes the dot is replaced by the plain `agentDoneCount`.
  agentBusy?: boolean;
  // Categories put activity in the count slot; other groups keep their leading marker.
  agentIndicatorPlacement?: 'leading' | 'count';
  agentDoneCount?: number;
  // The GROUP entity's OWN body (storyline / category prose) has unreviewed agent
  // changes. Takes priority over the child `agentDoneCount`: show "M" first, then
  // the child count once the group's own body is reviewed.
  agentSelfChanged?: boolean;
  // A newly created group body uses the IDE-style Added marker until its first
  // prose reveal completes. Added takes priority over Modified.
  agentSelfAdded?: boolean;
  onAgentSelfSeen?: () => void;
  onAgentChildrenSeen?: () => void;
}
export function GroupHeaderCell({
  name,
  count,
  showTotalCount = true,
  color,
  glyph,
  mark,
  variant = 'label',
  selected = false,
  collapsed,
  onToggleCollapsed,
  collapseDisabled = false,
  collapseChrome = 'chevron',
  onClick,
  onDoubleClick,
  onContextMenu,
  onPreviewEnter,
  onPreviewLeave,
  addButtonTitle,
  onAdd,
  addButtonHasPopup,
  addButtonExpanded,
  addButtonVisibility = 'hover',
  sticky = false,
  stickyBackground,
  rightExtra,
  agentBusy = false,
  agentIndicatorPlacement = 'leading',
  agentDoneCount = 0,
  agentSelfChanged = false,
  agentSelfAdded = false,
  onAgentSelfSeen,
  onAgentChildrenSeen,
}: GroupHeaderCellProps) {
  const { t } = useTranslation();
  const showRestingColorMarker = collapseChrome === 'chevron';
  const leadingBusy = agentIndicatorPlacement === 'leading' && agentBusy;
  const agentIndicator = agentBusy ? (
    <span
      className="agent-glyph-busy"
      title={t('agentActivity.working')}
      aria-label={t('agentActivity.working')}
      style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 2, background: 'hsl(var(--accent))' }}
    />
  ) : agentSelfAdded || agentSelfChanged ? (
    <AgentChangeIndicator
      onClick={onAgentSelfSeen}
      title={t(
        agentSelfAdded ? 'agentActivity.groupBodyAdded' : 'agentActivity.groupBodyChanged',
      )}
      style={{
        minWidth: 7,
        flexShrink: 0,
        textAlign: 'center',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--ui-font-caption, 10px)',
        fontWeight: 600,
        lineHeight: 1,
        color: 'hsl(var(--ink-2))',
      }}
    >
      {agentSelfAdded ? 'A' : 'M'}
    </AgentChangeIndicator>
  ) : agentDoneCount > 0 ? (
    <AgentCountBadge count={agentDoneCount} title={t('agentActivity.childChanges')} onClick={onAgentChildrenSeen} />
  ) : null;
  const countContent = agentIndicatorPlacement === 'count' && agentIndicator
    ? agentIndicator
    : showTotalCount ? <>· {count}</> : null;
  const addButton = addButtonTitle && onAdd ? (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onAdd(event);
      }}
      title={addButtonTitle}
      aria-haspopup={addButtonHasPopup}
      aria-expanded={addButtonHasPopup ? addButtonExpanded : undefined}
      className={`left-sb-group-add left-sb-inline-add-button${
        addButtonVisibility === 'always' ? ' left-sb-group-add--always' : ''
      }${addButtonExpanded ? ' left-sb-group-add--expanded' : ''}${
        collapseChrome === 'frame' ? ' left-sb-inline-add-button--frame' : ''
      }`}
      style={{ width: 18, height: 18 }}
    >
      <BrushIcon name="plus" size={12} />
    </button>
  ) : null;

  if (variant === 'cell') {
    const leading = agentIndicatorPlacement === 'leading' && !agentBusy && agentIndicator
      ? agentIndicator
      : mark;
    return (
      <SandCell
        selected={selected}
        color={color}
        markCenter={GROUP_CELL_PAD_LEFT + 7}
        className="left-sb-group-header left-sb-group-header--cell"
        onClick={onClick ?? (collapseDisabled ? undefined : onToggleCollapsed)}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          margin: '0 6px',
          padding: `3px 6px 3px ${GROUP_CELL_PAD_LEFT}px`,
          minHeight: 30,
          borderRadius: 3,
          cursor: 'pointer',
          fontSize: 'var(--ui-font-body, 12.5px)',
          lineHeight: 'var(--ui-line-body, 1.35)',
          color: selected ? 'hsl(var(--ink-1))' : 'hsl(var(--ink-2))',
        }}
      >
        <span style={{ display: 'flex', width: 14, flexShrink: 0, justifyContent: 'center' }}>{leading}</span>
        <span
          className="left-sb-group-header__name"
          onMouseEnter={(event) => onPreviewEnter?.(event.currentTarget)}
          onMouseLeave={onPreviewLeave}
          style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {name}
        </span>
        {countContent && <span
          className="left-sb-group-header__count"
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--ui-font-caption, 9.5px)',
            color: 'var(--ui-text-muted, hsl(var(--ink-4)))',
            flexShrink: 0,
          }}
        >
          {countContent}
        </span>}
        <span style={{ flex: 1 }} />
        {(rightExtra || addButton) && (
          <span className="left-sb-inline-actions">
            {rightExtra}
            {addButton}
          </span>
        )}
        <button
          type="button"
          className="left-sb-group-header__chevron"
          disabled={collapseDisabled}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand' : 'Collapse'}
          title={collapseDisabled ? undefined : collapsed ? 'Expand' : 'Collapse'}
          onClick={(event) => {
            event.stopPropagation();
            if (collapseDisabled) return;
            onToggleCollapsed();
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          {collapsed ? <BrushIcon name="chevron-right" size={11} /> : <BrushIcon name="chevron-down" size={11} />}
        </button>
      </SandCell>
    );
  }
  return (
    <div
      className={`left-sb-group-header${
        collapseChrome === 'frame'
          ? ` left-sb-group-header--frame ${collapsed ? 'is-collapsed' : 'is-expanded'}`
          : ''
      }`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-start',
        gap: 8,
        padding: collapseChrome === 'frame' ? '4px 0 4px 6px' : '4px 12px 4px 14px',
        cursor: onClick ? 'pointer' : 'default',
        ...(sticky
          ? {
              position: 'sticky',
              top: 0,
              zIndex: 4,
              // Use the same chrome-bg as the surrounding sidebar so the
              // sticky header reads as part of the panel surface, matching
              // surrounding element cells (which are transparent over the
              // same chrome background).
              background: stickyBackground ?? 'var(--chrome-bg)',
            }
          : {}),
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          minWidth: 0,
          flex: 1,
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--ui-font-caption, 9.5px)',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          color: 'var(--ui-text-muted, hsl(var(--ink-3)))',
        }}
      >
        {collapseChrome === 'chevron' && (
          <button
            type="button"
            disabled={collapseDisabled}
            onClick={(event) => {
              event.stopPropagation();
              if (collapseDisabled) return;
              onToggleCollapsed();
            }}
            title={collapseDisabled ? undefined : collapsed ? 'Expand' : 'Collapse'}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 14,
              height: 14,
              border: 'none',
              background: 'transparent',
              color: 'var(--ui-text-muted, hsl(var(--ink-4)))',
              cursor: collapseDisabled ? 'default' : 'pointer',
              padding: 0,
              flexShrink: 0,
            }}
          >
            {collapsed ? (
              <BrushIcon name="chevron-right" size={11} />
            ) : (
              <BrushIcon name="chevron-down" size={11} />
            )}
          </button>
        )}
        {agentIndicatorPlacement === 'leading' && !agentBusy && agentIndicator ? (
          agentIndicator
        ) : glyph ? (
          // Custom leading glyph (e.g. drift group folder) replaces the color
          // dot. Busy still tints it accent so the activity read survives.
          <span
            aria-hidden
            className={leadingBusy ? 'agent-glyph-busy' : undefined}
            title={leadingBusy ? t('agentActivity.working') : undefined}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              lineHeight: 1,
              color: leadingBusy ? 'hsl(var(--accent))' : 'hsl(var(--ink-3))',
            }}
          >
            {glyph}
          </span>
        ) : mark && collapseChrome === 'chevron' && !leadingBusy ? (
          mark
        ) : showRestingColorMarker || leadingBusy ? (
          <span
            aria-hidden
            className={leadingBusy ? 'agent-glyph-busy' : undefined}
            title={leadingBusy ? t('agentActivity.working') : undefined}
            style={{
              width: 7,
              height: 7,
              borderRadius: 2,
              // Busy overrides the group color with accent so the glow reads;
              // at rest it keeps the storyline/category color.
              background: leadingBusy ? 'hsl(var(--accent))' : color,
              flexShrink: 0,
            }}
          />
        ) : null}
        <div className="left-sb-group-header__legend">
          {collapseChrome === 'frame' && mark}
          {collapseChrome === 'frame' ? (
            <button
              type="button"
              className="left-sb-group-header__frame-label"
              aria-disabled={!onClick}
              onMouseEnter={(event) => onPreviewEnter?.(event.currentTarget)}
              onMouseLeave={onPreviewLeave}
              onFocus={(event) => onPreviewEnter?.(event.currentTarget)}
              onBlur={onPreviewLeave}
              onClick={(event) => {
                event.stopPropagation();
                onClick?.();
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                minWidth: 0,
                border: 0,
                padding: 0,
                background: 'transparent',
                cursor: onClick ? 'pointer' : 'default',
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--ui-font-caption, 9.5px)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.12em',
                  color: 'var(--ui-text-muted, hsl(var(--ink-3)))',
                  fontWeight: 500,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {name}
              </span>
            </button>
          ) : (
            <>
              <span
                onMouseEnter={(event) => onPreviewEnter?.(event.currentTarget)}
                onMouseLeave={onPreviewLeave}
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--ui-font-caption, 9.5px)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.12em',
                  color: 'var(--ui-text-muted, hsl(var(--ink-3)))',
                  fontWeight: 500,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {name}
              </span>
            </>
          )}
          {countContent && <span
            className="left-sb-group-header__count"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--ui-font-caption, 9.5px)',
              color: 'var(--ui-text-muted, hsl(var(--ink-4)))',
              flexShrink: 0,
            }}
          >
            {countContent}
          </span>}
          {collapseChrome === 'frame' && (
            <button
              type="button"
              className="left-sb-group-header__frame-disclosure"
              disabled={collapseDisabled}
              aria-expanded={!collapsed}
              aria-label={collapsed ? 'Expand' : 'Collapse'}
              title={collapseDisabled ? undefined : collapsed ? 'Expand' : 'Collapse'}
              onClick={(event) => {
                event.stopPropagation();
                if (collapseDisabled) return;
                onToggleCollapsed();
              }}
            >
              {collapsed ? <BrushIcon name="chevron-right" size={11} /> : <BrushIcon name="chevron-down" size={11} />}
            </button>
          )}

          {(rightExtra || addButton) && (
            <span className="left-sb-inline-actions">
              {rightExtra}
              {addButton}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
