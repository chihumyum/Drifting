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
import type { HoverAction, HoverActionGroup } from '../ui/HoverCard';

/** Surface-specific actions shown after an entity's own ones (story graph edges…). */
export interface EntityHoverExtraAction {
  action: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
}

/**
 * What an entity's hover card offers along its bottom: the writing status of
 * a chapter or drift as a choice group, then the same actions as the editor's
 * ⋯ menu (`getMenuItems`, so a new entry there shows up here too), then any
 * surface-specific groups. Every action goes through `onAction` with the
 * same action strings the editor uses.
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
    onSelect: () => onAction(item.action),
  });
  const own = getMenuItems(editorType, nodeStatusKind, t);
  if (own.length > 0) groups.push({ key: 'actions', actions: own.map(toAction) });
  (extraGroups ?? []).forEach((group, index) => {
    if (group.length > 0) groups.push({ key: `extra-${index}`, actions: group.map(toAction) });
  });
  return groups;
}
