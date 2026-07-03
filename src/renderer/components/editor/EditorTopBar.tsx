import { Check, LayoutGrid, Link2, ListTree, MessageSquare, MoreVertical } from 'lucide-react';
import {
  Children,
  Fragment,
  ReactNode,
  isValidElement,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  DRIFT_STATUSES,
  MANUAL_CHAPTER_WRITING_STATUSES,
  type WritingStatus,
} from '../../domain/book-node';
import { useUiStore } from '../../store/ui-store';

export type EditorType = 'node' | 'element' | 'category' | 'storyline';

// `chapter` for storyline-anchored nodes (the WritingStatus pipeline);
// `drift` for free-floating drift nodes (drifting / resting).
export type NodeStatusKind = 'chapter' | 'drift';

export const SET_STATUS_ACTION_PREFIX = 'setWritingStatus:';

export const WRITING_STATUS_LABELS: Record<WritingStatus, string> = {
  draft: 'Draft',
  waiting_review: 'Waiting for AI review',
  revising: 'Revising',
  finished: 'Finished',
  discarded: 'Discarded',
  drifting: 'Floating',
  resting: 'Resting',
};

export const STATUS_SECTION_LABEL: Record<NodeStatusKind, string> = {
  chapter: 'Writing status',
  drift: 'Drift status',
};

type Translate = (key: string) => string;

const WRITING_STATUS_LABEL_KEYS: Record<WritingStatus, string> = {
  draft: 'editorTopBar.status.draft',
  waiting_review: 'editorTopBar.status.waitingReview',
  revising: 'editorTopBar.status.revising',
  finished: 'editorTopBar.status.finished',
  discarded: 'editorTopBar.status.discarded',
  drifting: 'editorTopBar.status.drifting',
  resting: 'editorTopBar.status.resting',
};

const STATUS_SECTION_LABEL_KEYS: Record<NodeStatusKind, string> = {
  chapter: 'editorTopBar.statusSection.chapter',
  drift: 'editorTopBar.statusSection.drift',
};

export function getWritingStatusLabel(status: WritingStatus, translate?: Translate): string {
  return translate?.(WRITING_STATUS_LABEL_KEYS[status]) ?? WRITING_STATUS_LABELS[status];
}

export function getStatusSectionLabel(kind: NodeStatusKind, translate?: Translate): string {
  return translate?.(STATUS_SECTION_LABEL_KEYS[kind]) ?? STATUS_SECTION_LABEL[kind];
}

/*
  Shared editor top bar:
  - Outline toggle pinned at the far left (mirror of the comment-rail toggle
    on the right), driving the global `outlineCollapsed` UI flag
  - Breadcrumb area next to it, built from <EditorCrumb> children
  - Free-form right slot (word count, counts, etc.)
  - Integrated three-dot menu driven by `editorType` + `onMenuAction`
*/

interface EditorTopBarProps {
  children?: ReactNode;
  right?: ReactNode;
  editorType?: EditorType;
  onMenuAction?: (action: string) => void;
  // Only used when editorType === 'node'. Drives the status section at the
  // top of the three-dot menu; the current value is shown with a check.
  // `nodeStatusKind` picks the enum/labels (chapter or drift); both must be
  // supplied together for the section to render.
  nodeWritingStatus?: WritingStatus;
  nodeStatusKind?: NodeStatusKind;
  // Optional non-clickable label pinned to the top of the three-dot menu,
  // naming what the menu acts on. Used by the all-chapters view, where the menu
  // targets the chapter at the reading line (not the whole book) — without this
  // the menu would read as operating on 通览全书.
  menuHeader?: ReactNode;
  commentToggle?: {
    enabled: boolean;
    count: number;
    disabled?: boolean;
    onToggle: () => void;
  };
  referenceLinkToggle?: {
    enabled: boolean;
    onToggle: () => void;
  };
  // Toggles the in-chapter plot planner dock (mini-Excel grid). Only wired by
  // the node editor; absent on element/category/storyline editors.
  plotPlannerToggle?: {
    enabled: boolean;
    onToggle: () => void;
  };
}

export function EditorTopBar({
  children,
  right,
  editorType,
  onMenuAction,
  nodeWritingStatus,
  nodeStatusKind,
  menuHeader,
  commentToggle,
  referenceLinkToggle,
  plotPlannerToggle,
}: EditorTopBarProps) {
  const { t } = useTranslation();
  const crumbs = injectSeparators(children);
  const showMenu = Boolean(editorType && onMenuAction);
  const outlineCollapsed = useUiStore((s) => s.outlineCollapsed);
  const toggleOutline = useUiStore((s) => s.toggleOutlineCollapsed);

  return (
    <div className="editor-bar">
      <div className="editor-bar__left">
        <button
          type="button"
          className={`editor-bar__icon editor-bar__icon--outline${outlineCollapsed ? '' : ' editor-bar__icon--active'}`}
          title={
            outlineCollapsed
              ? t('editorTopBar.actions.showOutline')
              : t('editorTopBar.actions.hideOutline')
          }
          aria-pressed={!outlineCollapsed}
          onClick={toggleOutline}
        >
          <ListTree size={14} />
        </button>
        <div className="editor-crumbs">{crumbs}</div>
      </div>
      <div className="editor-bar__right">
        {right}
        {plotPlannerToggle && (
          <button
            type="button"
            className={`editor-bar__icon editor-bar__icon--planner${plotPlannerToggle.enabled ? ' editor-bar__icon--active' : ''}`}
            title={
              plotPlannerToggle.enabled
                ? t('editorTopBar.actions.collapsePlotPlanner')
                : t('editorTopBar.actions.expandPlotPlanner')
            }
            aria-pressed={plotPlannerToggle.enabled}
            onClick={plotPlannerToggle.onToggle}
          >
            <LayoutGrid size={14} />
          </button>
        )}
        {referenceLinkToggle && (
          <button
            type="button"
            className={`editor-bar__icon editor-bar__icon--reflink${referenceLinkToggle.enabled ? ' editor-bar__icon--active' : ''}`}
            title={
              referenceLinkToggle.enabled
                ? t('editorTopBar.actions.hideReferenceLinks')
                : t('editorTopBar.actions.showReferenceLinks')
            }
            aria-pressed={referenceLinkToggle.enabled}
            onClick={referenceLinkToggle.onToggle}
          >
            <Link2 size={14} />
          </button>
        )}
        {commentToggle && (
          <button
            type="button"
            className={`editor-bar__icon editor-bar__icon--comment${commentToggle.enabled ? ' editor-bar__icon--active' : ''}`}
            title={
              commentToggle.disabled
                ? t('editorTopBar.actions.noComments')
                : commentToggle.enabled
                  ? t('editorTopBar.actions.hideComments')
                  : t('editorTopBar.actions.showComments')
            }
            aria-pressed={commentToggle.enabled}
            disabled={commentToggle.disabled}
            onClick={commentToggle.onToggle}
          >
            <MessageSquare size={14} />
            {commentToggle.count > 0 && (
              <span className="editor-bar__badge">{commentToggle.count}</span>
            )}
          </button>
        )}
        {showMenu && editorType && onMenuAction && (
          <EditorBarMenu
            editorType={editorType}
            onAction={onMenuAction}
            nodeWritingStatus={nodeWritingStatus}
            nodeStatusKind={nodeStatusKind}
            menuHeader={menuHeader}
            translate={t}
          />
        )}
      </div>
    </div>
  );
}

function injectSeparators(children: ReactNode): ReactNode {
  const items = Children.toArray(children).filter(
    (child) => isValidElement(child) || typeof child === 'string',
  );
  return items.map((child, index) => (
    <Fragment key={index}>
      {index > 0 && <span className="editor-bar__sep">›</span>}
      {child}
    </Fragment>
  ));
}

interface EditorCrumbProps {
  children: ReactNode;
  dotColor?: string;
  dropdown?: ReactNode;
  onClick?: () => void;
}

export function EditorCrumb({ children, dotColor, dropdown, onClick }: EditorCrumbProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  // Only crumbs that actually do something on click get the pointer cursor +
  // hover affordance. A plain label crumb (project name, view title) is inert,
  // so it must read as inert rather than dangling a dead hover/click.
  const interactive = Boolean(onClick || dropdown);
  const className = `${dotColor ? 'editor-crumb editor-crumb-storyline' : 'editor-crumb'}${interactive ? ' editor-crumb--interactive' : ''}`;
  const style = dotColor ? ({ ['--crumb-color' as string]: dotColor } as React.CSSProperties) : undefined;

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      const active = document.activeElement;
      if (active instanceof HTMLElement && rootRef.current?.contains(active)) {
        active.blur();
      }
      setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape, true);
    };
  }, [open]);

  const handleClick = () => {
    if (dropdown) {
      setOpen((prev) => !prev);
    } else {
      onClick?.();
    }
  };

  return (
    <span
      ref={rootRef}
      className={className}
      style={style}
      onClick={interactive ? handleClick : undefined}
    >
      {dotColor && <span className="editor-crumb-dot" />}
      {children}
      {open && dropdown && (
        <div className="crumb-dropdown" onClick={() => setOpen(false)}>
          {dropdown}
        </div>
      )}
    </span>
  );
}

interface EditorBarMenuProps {
  editorType: EditorType;
  onAction: (action: string) => void;
  nodeWritingStatus?: WritingStatus;
  nodeStatusKind?: NodeStatusKind;
  menuHeader?: ReactNode;
  translate?: Translate;
}

function EditorBarMenu({
  editorType,
  onAction,
  nodeWritingStatus,
  nodeStatusKind,
  menuHeader,
  translate,
}: EditorBarMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) buttonRef.current?.blur();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      buttonRef.current?.blur();
      setIsOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape, true);
    };
  }, [isOpen]);

  const items = getMenuItems(editorType, nodeStatusKind, translate);
  const showStatus =
    editorType === 'node' && nodeWritingStatus !== undefined && nodeStatusKind !== undefined;
  const statusOptions: readonly WritingStatus[] = showStatus
    ? nodeStatusKind === 'drift'
      ? DRIFT_STATUSES
      : // Hand-pickable chapter states (shared with the chapter panel's cell
        // context menu). waiting_review / revising are system-driven (shadow
        // review) and never offered; picking 'finished' routes through the
        // shadow gate (see NodeEditorView).
        MANUAL_CHAPTER_WRITING_STATUSES
    : [];
  if (items.length === 0 && !showStatus && !menuHeader) return null;

  return (
    <div ref={menuRef} style={{ position: 'relative' }}>
      <button
        ref={buttonRef}
        type="button"
        className="editor-bar__icon"
        title={translate?.('editorTopBar.actions.more') ?? 'More actions'}
        onClick={() => setIsOpen((prev) => !prev)}
      >
        <MoreVertical size={14} />
      </button>

      {isOpen && (
        <div className="editor-bar__menu">
          {menuHeader && (
            <>
              <div className="editor-bar__menu-header">{menuHeader}</div>
              {(showStatus || items.length > 0) && <div className="editor-bar__menu-divider" />}
            </>
          )}
          {showStatus && nodeStatusKind && (
            <>
              <div className="editor-bar__menu-section-label">
                {getStatusSectionLabel(nodeStatusKind, translate)}
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
                      setIsOpen(false);
                    }}
                  >
                    <span>{getWritingStatusLabel(status, translate)}</span>
                    {active && <Check size={12} />}
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
                setIsOpen(false);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export interface MenuItem {
  action: string;
  label: string;
  danger?: boolean;
}

// Action names for drift → chapter / element conversions. Surfaced as named
// exports so NodeEditorView can branch on them without string duplication.
export const CONVERT_DRIFT_TO_CHAPTER_ACTION = 'convertDriftToChapter';
export const CONVERT_DRIFT_TO_ELEMENT_ACTION = 'convertDriftToElement';
// Move a drift into / out of a left-panel group (folder). Surfaced as a named
// export so both the left-panel cell menu (DriftPanel) and the editor top-bar
// menu (NodeEditorView) branch on the same action — single source of truth.
export const DRIFT_MOVE_TO_GROUP_ACTION = 'driftMoveToGroup';

// Exported so left-sidebar panel cells can render the same per-entity
// context menu as the editor top bar — single source of truth for menu
// options keeps the two surfaces aligned without duplication.
export function getMenuItems(
  editorType: EditorType,
  nodeStatusKind?: NodeStatusKind,
  translate?: Translate,
): MenuItem[] {
  const label = (key: string, fallback: string) => translate?.(key) ?? fallback;
  switch (editorType) {
    case 'node':
      // Drift nodes don't belong to a storyline yet — multi-select
      // "edit storylines" doesn't make sense pre-conversion. Surface the
      // conversion entries instead. Once converted, the menu naturally
      // flips back to the chapter set because nodeStatusKind changes.
      if (nodeStatusKind === 'drift') {
        return [
          {
            action: CONVERT_DRIFT_TO_CHAPTER_ACTION,
            label: label('editorTopBar.menu.convertToChapter', 'Convert to chapter…'),
          },
          {
            action: CONVERT_DRIFT_TO_ELEMENT_ACTION,
            label: label('editorTopBar.menu.convertToElement', 'Convert to element…'),
          },
          {
            action: DRIFT_MOVE_TO_GROUP_ACTION,
            label: label('editorTopBar.menu.moveToGroup', 'Move to group…'),
          },
          {
            action: 'deleteNode',
            label: label('editorTopBar.menu.deleteNode', 'Delete Node'),
            danger: true,
          },
        ];
      }
      return [
        {
          action: 'editNodeStorylines',
          label: label('editorTopBar.menu.editStorylines', 'Edit Storylines'),
        },
        {
          action: 'deleteNode',
          label: label('editorTopBar.menu.deleteNode', 'Delete Node'),
          danger: true,
        },
      ];
    case 'element':
      return [
        {
          action: 'categoryPicker',
          label: label('editorTopBar.menu.changeCategory', 'Change Category'),
        },
        {
          action: 'groupPicker',
          label: label('editorTopBar.menu.changeGroup', 'Change Group'),
        },
        {
          action: 'deleteElement',
          label: label('editorTopBar.menu.deleteElement', 'Delete Element'),
          danger: true,
        },
      ];
    case 'category':
      return [
        {
          action: 'deleteCategory',
          label: label('editorTopBar.menu.deleteCategory', 'Delete Category'),
          danger: true,
        },
      ];
    case 'storyline':
      return [
        {
          action: 'deleteStoryline',
          label: label('editorTopBar.menu.deleteStoryline', 'Delete Storyline'),
          danger: true,
        },
      ];
    default:
      return [];
  }
}
