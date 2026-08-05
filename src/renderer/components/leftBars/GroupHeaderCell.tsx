import { ChevronDown, ChevronRight, Minus, Plus } from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { AgentCountBadge } from './AgentCountBadge';

// Single source for the left-sidebar group-header cell. Storyline groups keep
// the ordinary [chevron] [color dot] row; compact Element categories opt into
// a frame mode where one leading disclosure morphs between minus and color dot.
//
// The component is purely presentational — it doesn't own collapse or
// add-affordance state, just renders the chrome and forwards the toggles.
// Hover-only actions are scoped to this header itself. That prevents hovering
// a parent group from revealing add buttons in every nested descendant.

export interface GroupHeaderCellProps {
  name: string;
  count: number;
  color: string;
  // Optional leading glyph rendered IN PLACE OF the color dot (e.g. a folder
  // icon for drift groups, to set them apart from the category color dot).
  // When omitted the color dot shows as before.
  glyph?: ReactNode;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  collapseDisabled?: boolean;
  // Element compact-index categories replace the ordinary chevron with a
  // state morph: expanded color becomes the surrounding category frame;
  // collapsed color returns as the small leading square in the exact position
  // occupied by the expanded minus. The label remains an editor link.
  collapseChrome?: 'chevron' | 'frame';
  // Whole-row click — typically "open this group's entity editor".
  onClick?: () => void;
  onDoubleClick?: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
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
  agentDoneCount?: number;
  // The GROUP entity's OWN body (storyline / category prose) has unreviewed agent
  // changes. Takes priority over the child `agentDoneCount`: show "M" first, then
  // the child count once the group's own body is reviewed.
  agentSelfChanged?: boolean;
  // A newly created group body uses the IDE-style Added marker until its first
  // prose reveal completes. Added takes priority over Modified.
  agentSelfAdded?: boolean;
}
export function GroupHeaderCell({
  name,
  count,
  color,
  glyph,
  collapsed,
  onToggleCollapsed,
  collapseDisabled = false,
  collapseChrome = 'chevron',
  onClick,
  onDoubleClick,
  onContextMenu,
  addButtonTitle,
  onAdd,
  addButtonHasPopup,
  addButtonExpanded,
  addButtonVisibility = 'hover',
  sticky = false,
  stickyBackground,
  rightExtra,
  agentBusy = false,
  agentDoneCount = 0,
  agentSelfChanged = false,
  agentSelfAdded = false,
}: GroupHeaderCellProps) {
  const { t } = useTranslation();
  const showRestingColorMarker = collapseChrome === 'chevron';
  const frameControlBackground =
    collapseChrome === 'frame' && !collapsed ? 'var(--chrome-bg)' : 'transparent';
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
        padding: '4px 12px 4px 14px',
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
          fontSize: 9.5,
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          color: 'hsl(var(--ink-3))',
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
              color: 'hsl(var(--ink-4))',
              cursor: collapseDisabled ? 'default' : 'pointer',
              padding: 0,
              flexShrink: 0,
            }}
          >
            {collapsed ? (
              <ChevronRight size={11} strokeWidth={2} />
            ) : (
              <ChevronDown size={11} strokeWidth={2} />
            )}
          </button>
        )}
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
            style={{ color: collapsed ? color : 'hsl(var(--ink-4))' }}
          >
            {collapsed ? (
              <span className="left-sb-group-header__frame-color-square" />
            ) : (
              <Minus size={11} strokeWidth={1.8} />
            )}
          </button>
        )}
        {!agentBusy && (agentSelfAdded || agentSelfChanged) ? (
          <span
            aria-hidden
            title={t(
              agentSelfAdded ? 'agentActivity.groupBodyAdded' : 'agentActivity.groupBodyChanged',
            )}
            style={{
              width: 7,
              flexShrink: 0,
              textAlign: 'center',
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              fontWeight: 600,
              lineHeight: 1,
              color: 'hsl(var(--ink-2))',
            }}
          >
            {agentSelfAdded ? 'A' : 'M'}
          </span>
        ) : !agentBusy && agentDoneCount > 0 ? (
          <AgentCountBadge count={agentDoneCount} title={t('agentActivity.childChanges')} />
        ) : glyph ? (
          // Custom leading glyph (e.g. drift group folder) replaces the color
          // dot. Busy still tints it accent so the activity read survives.
          <span
            aria-hidden
            className={agentBusy ? 'agent-glyph-busy' : undefined}
            title={agentBusy ? t('agentActivity.working') : undefined}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              lineHeight: 1,
              color: agentBusy ? 'hsl(var(--accent))' : 'hsl(var(--ink-3))',
            }}
          >
            {glyph}
          </span>
        ) : showRestingColorMarker || agentBusy ? (
          <span
            aria-hidden
            className={agentBusy ? 'agent-glyph-busy' : undefined}
            title={agentBusy ? t('agentActivity.working') : undefined}
            style={{
              width: 7,
              height: 7,
              borderRadius: 2,
              // Busy overrides the group color with accent so the glow reads;
              // at rest it keeps the storyline/category color.
              background: agentBusy ? 'hsl(var(--accent))' : color,
              flexShrink: 0,
            }}
          />
        ) : null}
        {collapseChrome === 'frame' ? (
          <button
            type="button"
            className="left-sb-group-header__frame-label"
            aria-disabled={!onClick}
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
              marginLeft: collapsed ? 0 : -6,
              padding: collapsed ? 0 : '0 6px',
              background: frameControlBackground,
              cursor: onClick ? 'pointer' : 'default',
            }}
          >
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 9.5,
                textTransform: 'uppercase',
                letterSpacing: '0.12em',
                color: 'hsl(var(--ink-3))',
                fontWeight: 500,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {name}
            </span>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 9.5,
                color: 'hsl(var(--ink-4))',
                flexShrink: 0,
              }}
            >
              · {count}
            </span>
          </button>
        ) : (
          <>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 9.5,
                textTransform: 'uppercase',
                letterSpacing: '0.12em',
                color: 'hsl(var(--ink-3))',
                fontWeight: 500,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {name}
            </span>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 9.5,
                color: 'hsl(var(--ink-4))',
                flexShrink: 0,
              }}
            >
              · {count}
            </span>
          </>
        )}

        {(rightExtra || (addButtonTitle && onAdd)) && (
          <span className="left-sb-inline-actions">
            {rightExtra}
            {addButtonTitle && onAdd && (
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
                <Plus size={12} strokeWidth={1.6} />
              </button>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
