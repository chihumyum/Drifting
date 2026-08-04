import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type EditorType,
  type MenuItem,
  type NodeStatusKind,
  getMenuItems,
  getStatusSectionLabel,
  getWritingStatusLabel,
  SET_STATUS_ACTION_PREFIX,
} from '../editor/EditorTopBar';
import {
  MANUAL_CHAPTER_WRITING_STATUSES,
  DRIFT_STATUSES,
  type WritingStatus,
} from '../../domain/book-node';
import { ContextMenuSurface } from '../ui/ContextMenuSurface';

// Header surface — title + optional subtitle + storyline tags, lifted from
// the old BottomTimeline-specific context menu so any caller can render
// the same "what am I right-clicking" preview as the cmenu top section.
export interface EntityCellContextMenuHeader {
  title?: string | null;
  subtitle?: string | null;
  tags?: Array<{ id: string; name: string; color?: string | null }>;
}

// Caller-supplied extra item groups appended to the canonical menu so
// surface-specific actions (e.g. StoryGraphView edge ops, SuperElementView
// new-edge) can live alongside the shared per-entity options. Each group
// renders as its own divided section in the order supplied.
export interface EntityCellContextMenuItem {
  action: string;
  label: string;
  danger?: boolean;
  // Optional disabled state — rendered grey + click ignored. Use for
  // "needs ≥ 1 edge"-style affordances that should stay visible for
  // discoverability.
  disabled?: boolean;
}

export interface EntityCellContextMenuProps {
  // Anchor coordinates from the contextmenu event. Viewport-relative; the
  // menu nudges itself back inside the viewport after first render.
  x: number;
  y: number;
  editorType: EditorType;
  // Only relevant for editorType === 'node' — drives both the writing-status
  // section AND the chapter/drift action set.
  nodeStatusKind?: NodeStatusKind;
  nodeWritingStatus?: WritingStatus;
  header?: EntityCellContextMenuHeader;
  // Extra item groups appended after the canonical entity menu. Empty
  // groups are skipped silently so callers can always pass the array.
  extraGroups?: EntityCellContextMenuItem[][];
  onAction: (action: string) => void;
  onClose: () => void;
}

// Per-cell context menu reused by every left-sidebar panel. Items come from
// EditorTopBar's `getMenuItems` so adding a new menu entry there
// automatically shows up here. The component handles outside-click /
// Escape dismissal and viewport clamping; callers only render it when their
// cell registers a contextmenu event.
export function EntityCellContextMenu({
  x,
  y,
  editorType,
  nodeStatusKind,
  nodeWritingStatus,
  header,
  extraGroups,
  onAction,
  onClose,
}: EntityCellContextMenuProps) {
  const { t } = useTranslation();

  const items: MenuItem[] = getMenuItems(editorType, nodeStatusKind, t);
  const showStatus =
    editorType === 'node' && nodeWritingStatus !== undefined && nodeStatusKind !== undefined;
  const statusOptions: readonly WritingStatus[] = showStatus
    ? nodeStatusKind === 'drift'
      ? DRIFT_STATUSES
      : MANUAL_CHAPTER_WRITING_STATUSES
    : [];
  const filledExtraGroups = (extraGroups ?? []).filter((g) => g.length > 0);
  const hasHeader = Boolean(
    header && (header.title || header.subtitle || (header.tags && header.tags.length > 0)),
  );

  if (!showStatus && items.length === 0 && filledExtraGroups.length === 0 && !hasHeader) {
    return null;
  }

  return (
    <ContextMenuSurface x={x} y={y} onClose={onClose}>
      {hasHeader && header && (
        <>
          <div
            style={{
              padding: '4px 10px 6px',
              maxWidth: 280,
              borderBottom: '1px solid hsl(var(--rule))',
              marginBottom: 4,
            }}
          >
            {header.title && (
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'hsl(var(--ink-1))',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {header.title}
              </div>
            )}
            {header.subtitle && (
              <div
                style={{
                  marginTop: 2,
                  fontSize: 11,
                  color: 'hsl(var(--ink-3))',
                  fontFamily: 'var(--font-sans)',
                  fontStyle: 'italic',
                  overflow: 'hidden',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                }}
              >
                {header.subtitle}
              </div>
            )}
            {header.tags && header.tags.length > 0 && (
              <div
                style={{
                  marginTop: 6,
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 4,
                }}
              >
                {header.tags.map((tag) => (
                  <span
                    key={tag.id}
                    style={{
                      fontSize: 10,
                      padding: '1px 6px',
                      borderRadius: 1,
                      color: 'hsl(var(--paper))',
                      background: tag.color || 'hsl(var(--accent))',
                      maxWidth: 120,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {tag.name || t('common.untitled')}
                  </span>
                ))}
              </div>
            )}
          </div>
        </>
      )}
      {showStatus && nodeStatusKind && (
        <>
          <div className="editor-bar__menu-section-label">
            {getStatusSectionLabel(nodeStatusKind, t)}
          </div>
          {statusOptions.map((status) => {
            const active = status === nodeWritingStatus;
            return (
              <button
                key={status}
                type="button"
                className={`editor-bar__menu-item editor-bar__menu-item--status${active ? ' editor-bar__menu-item--active' : ''}`}
                onClick={() => {
                  if (!active) onAction(`${SET_STATUS_ACTION_PREFIX}${status}`);
                  onClose();
                }}
              >
                <span>{getWritingStatusLabel(status, t)}</span>
                {active && <span aria-hidden>✓</span>}
              </button>
            );
          })}
          {items.length > 0 && <div className="editor-bar__menu-divider" />}
        </>
      )}
      {items.map((item) => (
        <button
          key={item.action}
          type="button"
          className={`editor-bar__menu-item${item.danger ? ' editor-bar__menu-item--danger' : ''}`}
          onClick={() => {
            onAction(item.action);
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
      {filledExtraGroups.map((group, gIdx) => (
        <Fragment key={`extra-${gIdx}`}>
          {(items.length > 0 || gIdx > 0) && <div className="editor-bar__menu-divider" />}
          {group.map((item) => (
            <button
              key={item.action}
              type="button"
              disabled={item.disabled}
              className={`editor-bar__menu-item${item.danger ? ' editor-bar__menu-item--danger' : ''}`}
              style={item.disabled ? { opacity: 0.45, cursor: 'default' } : undefined}
              onClick={() => {
                if (item.disabled) return;
                onAction(item.action);
                onClose();
              }}
            >
              {item.label}
            </button>
          ))}
        </Fragment>
      ))}
    </ContextMenuSurface>
  );
}
