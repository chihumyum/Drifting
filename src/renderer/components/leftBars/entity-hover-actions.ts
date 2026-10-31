import type { TFunction } from 'i18next';
import {
  type EditorType,
  type NodeStatusKind,
  getMenuItems,
  getStatusSectionLabel,
  getWritingStatusLabel,
  SET_STATUS_ACTION_PREFIX,
} from '../editor/EditorTopBar';
import { MANUAL_CHAPTER_WRITING_STATUSES, DRIFT_STATUSES, type WritingStatus } from '../../domain/book-node';
import type { BrushIconName } from '../ui/BrushIcon';
import type { HoverAction, HoverActionGroup } from '../ui/HoverCard';

/** Surface-specific actions shown after an entity's own ones (story graph edges…). */
export interface EntityHoverExtraAction {
  action: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
}

/** Each writing status leads with the menus' own mark for it. */
export const WRITING_STATUS_ICONS: Record<WritingStatus, BrushIconName> = {
  draft: 'brush-lifted',
  finished: 'brush-laid',
  discarded: 'brush-broken',
  drifting: 'fluff',
  resting: 'stone-sunk',
};

/**
 * The mark each entity action leads with. An action that opens more (a
 * conversion's dialog, a list to choose from) takes none: it is a section's
 * header, not one of its rows.
 */
const ACTION_ICONS: Record<string, BrushIconName> = {
  editNodeStorylines: 'branch',
  groupPicker: 'folder',
  deleteNode: 'trash',
  deleteElement: 'trash',
  deleteCategory: 'trash',
  deleteStoryline: 'trash',
  deleteAllEdges: 'trash',
  startEdgeFrom: 'knot-links',
  newElement: 'plus',
  unpin: 'rotate',
  moveToUnaffiliated: 'gate-out',
  detachFromNarrative: 'arrow-back',
};

/**
 * What an entity's hover card offers as its rows: the writing status of a
 * chapter or drift as a choice of its own, then the same actions as the
 * editor's ⋯ menu (`getMenuItems`, so a new entry there shows up here too),
 * then any surface-specific groups. Every action goes through `onAction`
 * with the same action strings the editor uses.
 */
export function entityHoverActions({
  editorType,
  nodeStatusKind,
  nodeWritingStatus,
  extraGroups,
  onAction,
  t,
}: {
  editorType: EditorType;
  nodeStatusKind?: NodeStatusKind;
  nodeWritingStatus?: WritingStatus;
  extraGroups?: EntityHoverExtraAction[][];
  onAction: (action: string) => void;
  t: TFunction;
}): HoverActionGroup[] {
  const groups: HoverActionGroup[] = [];
  if (editorType === 'node' && nodeStatusKind && nodeWritingStatus !== undefined) {
    const statuses: readonly WritingStatus[] = nodeStatusKind === 'drift' ? DRIFT_STATUSES : MANUAL_CHAPTER_WRITING_STATUSES;
    groups.push({
      key: 'status',
      label: getStatusSectionLabel(nodeStatusKind, t),
      actions: statuses.map((status) => ({
        key: `status:${status}`,
        label: getWritingStatusLabel(status, t),
        icon: { brush: WRITING_STATUS_ICONS[status] },
        active: status === nodeWritingStatus,
        onSelect: () => {
          if (status !== nodeWritingStatus) onAction(`${SET_STATUS_ACTION_PREFIX}${status}`);
        },
      })),
    });
  }
  const toAction = (item: { action: string; label: string; danger?: boolean; disabled?: boolean }): HoverAction => ({
    key: item.action,
    label: item.label,
    danger: item.danger,
    disabled: item.disabled,
    icon: ACTION_ICONS[item.action] ? { brush: ACTION_ICONS[item.action] } : undefined,
    onSelect: () => onAction(item.action),
  });
  const own = getMenuItems(editorType, nodeStatusKind, t);
  if (own.length > 0) groups.push({ key: 'actions', actions: own.map(toAction) });
  (extraGroups ?? []).forEach((group, index) => {
    if (group.length > 0) groups.push({ key: `extra-${index}`, actions: group.map(toAction) });
  });
  return groups;
}
