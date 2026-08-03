import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { AgentCountBadge } from './AgentCountBadge';

// Single source for the left-sidebar group-header cell. Storyline groups in
// ChapterPanel and category groups in ElementPanel both render the same
// row: [chevron] [color dot] [NAME · count] [hover-revealed + button].
//
// The component is purely presentational — it doesn't own collapse or
// add-affordance state, just renders the chrome and forwards the toggles.
// Callers add hover affordances by wrapping in a `.left-sb-group` element
// (or any container with the .left-sb-group class) so the existing
// `.left-sb-group:hover .left-sb-group-add { opacity: 1 }` rule keeps
// working without per-panel duplication.

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
  // Whole-row click — typically "open this group's entity editor".
  onClick?: () => void;
  onDoubleClick?: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
  // Title shown as the + button tooltip. When omitted, the + button is
  // skipped entirely (useful for read-only group headers).
  addButtonTitle?: string;
  onAdd?: () => void;
  // Optional sticky positioning for headers that should stay visible while
  // the user scrolls their group's body (ElementPanel category headers do
  // this so the group label remains in view).
  sticky?: boolean;
  // Optional extra slot rendered between the count and the + button.
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
  onClick,
  onDoubleClick,
  onContextMenu,
  addButtonTitle,
  onAdd,
  sticky = false,
  rightExtra,
  agentBusy = false,
  agentDoneCount = 0,
  agentSelfChanged = false,
  agentSelfAdded = false,
}: GroupHeaderCellProps) {
  const { t } = useTranslation();
  return (
    <div
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
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
              background: 'var(--chrome-bg)',
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
        <button
          onClick={(event) => {
            event.stopPropagation();
            onToggleCollapsed();
          }}
          title={collapsed ? 'Expand' : 'Collapse'}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 14,
            height: 14,
            border: 'none',
            background: 'transparent',
            color: 'hsl(var(--ink-4))',
            cursor: 'pointer',
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
        {!agentBusy && (agentSelfAdded || agentSelfChanged) ? (
          <span
            aria-hidden
            title={t(
              agentSelfAdded
                ? 'agentActivity.groupBodyAdded'
                : 'agentActivity.groupBodyChanged',
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
        ) : (
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
        )}
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
      </div>

      {rightExtra}

      {addButtonTitle && onAdd && (
        <button
          onClick={(event) => {
            event.stopPropagation();
            onAdd();
          }}
          title={addButtonTitle}
          className="left-sb-group-add"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 18,
            height: 18,
            borderRadius: 3,
            border: 'none',
            background: 'transparent',
            color: 'hsl(var(--ink-4))',
            cursor: 'pointer',
            padding: 0,
            transition: 'opacity 0.12s, background 0.12s, color 0.12s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'hsl(var(--paper-deep))';
            e.currentTarget.style.color = 'hsl(var(--ink-1))';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'hsl(var(--ink-4))';
          }}
        >
          <Plus size={12} strokeWidth={1.6} />
        </button>
      )}
    </div>
  );
}
