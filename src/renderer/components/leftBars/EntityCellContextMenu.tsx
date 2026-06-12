import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  type EditorType,
  type MenuItem,
  type NodeStatusKind,
  getMenuItems,
  SET_STATUS_ACTION_PREFIX,
  STATUS_SECTION_LABEL,
  WRITING_STATUS_LABELS,
} from '../editor/EditorTopBar';
import {
  MANUAL_CHAPTER_WRITING_STATUSES,
  DRIFT_STATUSES,
  type WritingStatus,
} from '../../domain/book-node';

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
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 6;
    let left = x;
    let top = y;
    if (left + rect.width + pad > window.innerWidth) {
      left = Math.max(pad, window.innerWidth - rect.width - pad);
    }
    if (top + rect.height + pad > window.innerHeight) {
      top = Math.max(pad, window.innerHeight - rect.height - pad);
    }
    setPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRef.current) return;
      if (menuRef.current.contains(event.target as Node)) return;
      onClose();
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    // Capture so we beat React's synthetic delegation when the click
    // originated outside this component.
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKey, true);
    };
  }, [onClose]);

  const items: MenuItem[] = getMenuItems(editorType, nodeStatusKind);
  const showStatus =
    editorType === 'node' && nodeWritingStatus !== undefined && nodeStatusKind !== undefined;
  const statusOptions: readonly WritingStatus[] = showStatus
    ? nodeStatusKind === 'drift'
      ? DRIFT_STATUSES
      : // Same hand-pickable subset as the editor top bar — waiting_review /
        // revising are system-driven and never offered here.
        MANUAL_CHAPTER_WRITING_STATUSES
    : [];
  const filledExtraGroups = (extraGroups ?? []).filter((g) => g.length > 0);
  const hasHeader = Boolean(
    header && (header.title || header.subtitle || (header.tags && header.tags.length > 0)),
  );

  if (!showStatus && items.length === 0 && filledExtraGroups.length === 0 && !hasHeader) {
    return null;
  }

  // Portal to <body> so the menu escapes any ancestor that creates a new
  // containing block for `position: fixed` (modern skin gives `.app-chrome`
  // a `backdrop-filter`, which per CSS spec re-anchors fixed descendants to
  // the chrome instead of the viewport — making the menu drop by the chrome's
  // viewport offset and clip against `.app-island`'s `overflow: hidden`).
  return createPortal(
    <div
      ref={menuRef}
      className="editor-bar__menu"
      role="menu"
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        // The .editor-bar__menu class is built for absolute-positioned
        // anchoring (top/right relative to its trigger). Reset right/bottom
        // so the menu shrinks to content width at our fixed (left, top)
        // instead of stretching to the viewport's right edge.
        right: 'auto',
        bottom: 'auto',
        zIndex: 10000,
        margin: 0,
      }}
    >
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
                  fontFamily: 'var(--font-serif)',
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
                {header.tags.map((t) => (
                  <span
                    key={t.id}
                    style={{
                      fontSize: 10,
                      padding: '1px 6px',
                      borderRadius: 8,
                      color: 'hsl(var(--paper))',
                      background: t.color || 'hsl(var(--accent))',
                      maxWidth: 120,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {t.name || 'Untitled'}
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
            {STATUS_SECTION_LABEL[nodeStatusKind]}
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
                <span>{WRITING_STATUS_LABELS[status]}</span>
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
    </div>,
    document.body,
  );
}
