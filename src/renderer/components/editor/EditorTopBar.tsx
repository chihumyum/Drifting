import { Fragment, type ReactNode, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DRIFT_STATUSES,
  MANUAL_CHAPTER_WRITING_STATUSES,
  type WritingStatus,
} from '../../domain/book-node';
import { useSettingsStore } from '../../store/settings-store';
import { AnchoredPopover } from '../ui/AnchoredPopover';
import { BrushIcon, type BrushIconName } from '../ui/BrushIcon';
import { MenuRowIcon, type MenuRowIconSpec } from '../ui/MenuRowIcon';
import { TimelineToggle } from '../workspaceChrome/WorkspaceTabDock';
import { useEditorCornerHostsTimelineToggle } from './editor-corner';
import { useEditorRailPresentation } from './editor-rail-presentation';
import { MarkdownShareDialog } from './MarkdownShareDialog';
import type { MarkdownShareTarget } from '../../services/export/markdown-share';

export type EditorType = 'node' | 'element' | 'category' | 'storyline' | 'library_item';

// `chapter` for storyline-anchored nodes (the WritingStatus pipeline);
// `drift` for free-floating drift nodes (drifting / resting).
export type NodeStatusKind = 'chapter' | 'drift';

export const SET_STATUS_ACTION_PREFIX = 'setWritingStatus:';

export const WRITING_STATUS_LABELS: Record<WritingStatus, string> = {
  draft: 'Draft',
  finished: 'Finished',
  discarded: 'Discarded',
  drifting: 'Floating',
  resting: 'Resting',
};

export const STATUS_SECTION_LABEL: Record<NodeStatusKind, string> = {
  chapter: 'Writing status',
  drift: 'Idea status',
};

type Translate = (key: string) => string;

const WRITING_STATUS_LABEL_KEYS: Record<WritingStatus, string> = {
  draft: 'editorTopBar.status.draft',
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
  Shared editor actions. There is no bar or breadcrumb: the document's own
  controls stand in a vertical stack at the lower-right corner of its paper,
  one stack per editor pane, so split editors never share them.
  - Plot planner, element image, outline rail and Entity Link highlighting
  - Margin comments with their count
  - Integrated three-dot menu driven by `editorType` + `onMenuAction`
*/

interface EditorTopBarProps {
  // Element image entry (thumbnail button + popover), placed left of the
  // outline toggle. Only the element editor supplies it.
  imageEntry?: ReactNode;
  editorType?: EditorType;
  onMenuAction?: (action: string) => void;
  shareTarget?: MarkdownShareTarget;
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
  // Surfaces without an outline rail (image and PDF materials) hide its toggle.
  outlineToggle?: boolean;
  // Menu actions that do not apply to this particular entity.
  hiddenMenuActions?: readonly string[];
}

export function EditorTopBar({
  imageEntry,
  editorType,
  onMenuAction,
  shareTarget,
  nodeWritingStatus,
  nodeStatusKind,
  menuHeader,
  commentToggle,
  referenceLinkToggle,
  plotPlannerToggle,
  outlineToggle = true,
  hiddenMenuActions,
}: EditorTopBarProps) {
  const { t } = useTranslation();
  const [shareRequest, setShareRequest] = useState<MarkdownShareTarget | null>(null);
  const showMenu = Boolean(editorType && onMenuAction);
  const hostsTimelineToggle = useEditorCornerHostsTimelineToggle();

  return (
    // The paper's lower-right corner: the Bottom Timeline toggle (on the
    // right-hand pane only), then the document's own controls as one
    // horizontal glass pill, each control a round glass button inside it.
    <div className="editor-corner">
      {hostsTimelineToggle && <TimelineToggle />}
      <div className="editor-bar glass glass--rest" role="toolbar" aria-orientation="horizontal">
        {plotPlannerToggle && (
          <button
            type="button"
            className={`editor-bar__icon glass glass--round editor-bar__icon--planner${plotPlannerToggle.enabled ? ' editor-bar__icon--active' : ''}`}
            title={
              plotPlannerToggle.enabled
                ? t('editorTopBar.actions.collapsePlotPlanner')
                : t('editorTopBar.actions.expandPlotPlanner')
            }
            aria-pressed={plotPlannerToggle.enabled}
            onClick={plotPlannerToggle.onToggle}
          >
            <BrushIcon name="plan-go" />
          </button>
        )}
        {imageEntry}
        {((editorType && outlineToggle) || referenceLinkToggle) && (
          <div className="editor-bar__toggle-group">
            {editorType && outlineToggle && <OutlineRailToggle translate={t} />}
            {referenceLinkToggle && (
              <button
                type="button"
                className={`editor-bar__icon glass glass--round editor-bar__icon--reflink${referenceLinkToggle.enabled ? ' editor-bar__icon--active' : ''}`}
                title={
                  referenceLinkToggle.enabled
                    ? t('editorTopBar.actions.hideReferenceLinks')
                    : t('editorTopBar.actions.showReferenceLinks')
                }
                aria-pressed={referenceLinkToggle.enabled}
                onClick={referenceLinkToggle.onToggle}
              >
                <BrushIcon name="knot-links" />
              </button>
            )}
          </div>
        )}
        {commentToggle && (
          <button
            type="button"
            className={`editor-bar__icon glass glass--round editor-bar__icon--comment${commentToggle.enabled ? ' editor-bar__icon--active' : ''}`}
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
            <BrushIcon name="comment" />
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
            hiddenActions={hiddenMenuActions}
            translate={t}
            onShare={shareTarget ? () => setShareRequest({ ...shareTarget }) : undefined}
          />
        )}
        {shareRequest && <MarkdownShareDialog target={shareRequest} onClose={() => setShareRequest(null)} />}
      </div>
    </div>
  );
}

function OutlineRailToggle({ translate }: { translate: Translate }) {
  const mode = useSettingsStore((state) => state.outlineRailMode);
  const setMode = useSettingsStore((state) => state.setOutlineRailMode);
  const presentation = useEditorRailPresentation();
  const owned = presentation?.onOutlineToggle;
  const visible = owned ? presentation.outlineVisible === true : mode === 'visible';
  const title = translate(
    visible ? 'editorTopBar.outlineRailMode.hidden' : 'editorTopBar.outlineRailMode.visible',
  );

  return (
    <button
      type="button"
      className={`editor-bar__icon glass glass--round editor-bar__icon--outline${visible ? ' editor-bar__icon--active' : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={visible}
      onClick={owned ?? (() => setMode(visible ? 'hidden' : 'visible'))}
    >
      <BrushIcon name="toc-raked" />
    </button>
  );
}

interface EditorBarMenuProps {
  editorType: EditorType;
  onAction: (action: string) => void;
  nodeWritingStatus?: WritingStatus;
  nodeStatusKind?: NodeStatusKind;
  menuHeader?: ReactNode;
  hiddenActions?: readonly string[];
  translate?: Translate;
  onShare?: () => void;
}

function EditorBarMenu({
  editorType,
  onAction,
  nodeWritingStatus,
  nodeStatusKind,
  menuHeader,
  hiddenActions,
  translate,
  onShare,
}: EditorBarMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const items = getMenuItems(editorType, nodeStatusKind, translate).filter(
    (item) => !hiddenActions?.includes(item.action),
  );
  const showStatus =
    editorType === 'node' && nodeWritingStatus !== undefined && nodeStatusKind !== undefined;
  const statusOptions: readonly WritingStatus[] = showStatus
    ? nodeStatusKind === 'drift'
      ? DRIFT_STATUSES
      : MANUAL_CHAPTER_WRITING_STATUSES
    : [];
  if (items.length === 0 && !showStatus && !menuHeader) return null;

  const actionRow = (item: MenuItem) => (
    <button
      key={item.action}
      type="button"
      role="menuitem"
      className={`menu-surface__item${item.danger ? ' menu-surface__item--danger' : ''}`}
      onClick={() => {
        onAction(item.action);
        setIsOpen(false);
      }}
    >
      <MenuRowIcon icon={item.icon} />
      <span>{item.label}</span>
    </button>
  );
  const plain = items.filter((item) => !item.danger);
  const destructive = items.filter((item) => item.danger);
  // The plain actions, the writing status, then what destroys: each group
  // parted from the next by a hairline.
  const groups: { key: string; content: ReactNode }[] = [];
  if (onShare || plain.length > 0) {
    groups.push({
      key: 'actions',
      content: (
        <>
          {onShare && (
            <button type="button" role="menuitem" className="menu-surface__item" onClick={() => {
              setIsOpen(false);
              onShare();
            }}>
              <BrushIcon name="share" size={16} />
              <span>{translate?.('markdownShare.menu') ?? 'Share'}</span>
            </button>
          )}
          {plain.map(actionRow)}
        </>
      ),
    });
  }
  if (showStatus && nodeStatusKind) {
    groups.push({
      key: 'status',
      content: (
        <>
          <div className="menu-surface__section-label">
            {getStatusSectionLabel(nodeStatusKind, translate)}
          </div>
          {statusOptions.map((status) => {
            const active = status === nodeWritingStatus;
            return (
              <button
                key={status}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className="menu-surface__item"
                onClick={() => {
                  if (!active) onAction(`${SET_STATUS_ACTION_PREFIX}${status}`);
                  setIsOpen(false);
                }}
              >
                <BrushIcon name={WRITING_STATUS_ICON[status]} size={16} />
                <span>{getWritingStatusLabel(status, translate)}</span>
                {active && <BrushIcon name="check" size={12} className="menu-surface__check" />}
              </button>
            );
          })}
        </>
      ),
    });
  }
  if (destructive.length > 0) {
    groups.push({ key: 'destructive', content: <>{destructive.map(actionRow)}</> });
  }

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={buttonRef}
        type="button"
        className="editor-bar__icon glass glass--round"
        title={translate?.('editorTopBar.actions.more') ?? 'More actions'}
        aria-label={translate?.('editorTopBar.actions.more') ?? 'More actions'}
        onClick={() => setIsOpen((prev) => !prev)}
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        <BrushIcon name="more" />
      </button>

      <AnchoredPopover
        anchorRef={buttonRef}
        open={isOpen}
        onClose={() => setIsOpen(false)}
        placement="top-end"
        className="menu-surface menu-surface--standard editor-bar__menu"
        role="menu"
      >
          {menuHeader && <div className="menu-surface__header">{menuHeader}</div>}
          {groups.map((group, index) => (
            <Fragment key={group.key}>
              {(index > 0 || menuHeader) && <div className="menu-surface__divider" />}
              {group.content}
            </Fragment>
          ))}
      </AnchoredPopover>
    </div>
  );
}

export interface MenuItem {
  action: string;
  label: string;
  /** Every row of a menu leads with its icon. */
  icon: MenuRowIconSpec;
  danger?: boolean;
}

// 提笔 / 搁笔 / 折笔 for a chapter's draft, finished and abandoned states; a
// drift drifts like a seed on its fluff and rests like a sunk stone.
const WRITING_STATUS_ICON: Record<WritingStatus, BrushIconName> = {
  draft: 'brush-lifted',
  finished: 'brush-laid',
  discarded: 'brush-broken',
  drifting: 'fluff',
  resting: 'stone-sunk',
};

// Action names for drift → chapter / element conversions. Surfaced as named
// exports so NodeEditorView can branch on them without string duplication.
export const CONVERT_DRIFT_TO_CHAPTER_ACTION = 'convertDriftToChapter';
export const CONVERT_DRIFT_TO_ELEMENT_ACTION = 'convertDriftToElement';
// Move a drift into / out of a left-panel group (folder). Surfaced as a named
// export so both the left-panel cell menu (DriftPanel) and the editor top-bar
// menu (NodeEditorView) branch on the same action — single source of truth.
export const DRIFT_MOVE_TO_GROUP_ACTION = 'driftMoveToGroup';
// Image/PDF materials only; notes have no system-app representation.
export const MATERIAL_OPEN_IN_SYSTEM_ACTION = 'openMaterialInSystem';
// Notes only: the per-note switch for projecting checklist items as TODOs.
// The material view hides whichever of the pair does not apply.
export const NOTE_TASK_TODOS_OFF_ACTION = 'noteTaskTodosOff';
export const NOTE_TASK_TODOS_ON_ACTION = 'noteTaskTodosOn';
export const MATERIAL_MOVE_TO_FOLDER_ACTION = 'moveMaterialToFolder';

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
            icon: { kind: 'chapter' },
          },
          {
            action: CONVERT_DRIFT_TO_ELEMENT_ACTION,
            label: label('editorTopBar.menu.convertToElement', 'Convert to element…'),
            icon: { kind: 'element' },
          },
          {
            action: DRIFT_MOVE_TO_GROUP_ACTION,
            label: label('editorTopBar.menu.moveToGroup', 'Move to group…'),
            icon: 'folder',
          },
          {
            action: 'deleteNode',
            label: label('editorTopBar.menu.deleteNode', 'Delete Node'),
            icon: 'trash',
            danger: true,
          },
        ];
      }
      return [
        {
          action: 'editNodeStorylines',
          label: label('editorTopBar.menu.editStorylines', 'Edit Storylines'),
          icon: 'branch',
        },
        {
          action: 'deleteNode',
          label: label('editorTopBar.menu.deleteNode', 'Delete Node'),
          icon: 'trash',
          danger: true,
        },
      ];
    case 'element':
      return [
        {
          action: 'categoryPicker',
          label: label('editorTopBar.menu.changeCategory', 'Change Category'),
          icon: { kind: 'category' },
        },
        {
          action: 'groupPicker',
          label: label('editorTopBar.menu.changeGroup', 'Change Group'),
          icon: 'folder',
        },
        {
          action: 'deleteElement',
          label: label('editorTopBar.menu.deleteElement', 'Delete Element'),
          icon: 'trash',
          danger: true,
        },
      ];
    case 'category':
      return [
        {
          action: 'deleteCategory',
          label: label('editorTopBar.menu.deleteCategory', 'Delete Category'),
          icon: 'trash',
          danger: true,
        },
      ];
    case 'storyline':
      return [
        {
          action: 'deleteStoryline',
          label: label('editorTopBar.menu.deleteStoryline', 'Delete Storyline'),
          icon: 'trash',
          danger: true,
        },
      ];
    case 'library_item':
      return [
        {
          action: MATERIAL_OPEN_IN_SYSTEM_ACTION,
          label: label('editorTopBar.menu.openMaterialInSystem', 'Open in default app'),
          icon: 'arrow-out',
        },
        {
          action: MATERIAL_MOVE_TO_FOLDER_ACTION,
          label: label('editorTopBar.menu.moveMaterialToFolder', 'Move to folder…'),
          icon: 'folder',
        },
        {
          action: NOTE_TASK_TODOS_OFF_ACTION,
          label: label('editorTopBar.menu.noteTaskTodosOff', 'Stop syncing checklist to TODOs'),
          icon: 'checklist',
        },
        {
          action: NOTE_TASK_TODOS_ON_ACTION,
          label: label('editorTopBar.menu.noteTaskTodosOn', 'Sync checklist to TODOs'),
          icon: 'checklist',
        },
        {
          action: 'deleteMaterial',
          label: label('editorTopBar.menu.deleteMaterial', 'Delete material'),
          icon: 'trash',
          danger: true,
        },
      ];
    default:
      return [];
  }
}
