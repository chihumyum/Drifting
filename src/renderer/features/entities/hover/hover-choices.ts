import type { TFunction } from 'i18next';

import type { BookNode } from '../../../domain/book-node';
import { buildDriftGroupChildren, ROOT_GROUP_KEY, type DriftGroup } from '../../../domain/drift-group';
import { DRIFT_MOVE_TO_GROUP_ACTION } from '../../../components/editor/EditorTopBar';
import type { HoverAction, HoverActionGroup } from '../../../components/ui/HoverCard';

/**
 * A hover card's cells that offer several choices are sections of their own
 * (HoverCardActions folds them until their header is pressed). These turn an
 * entity action into such a section: the action keeps its place and label,
 * loses its own `onSelect`, and carries its `choices`, each led by a mark.
 */
function replaceAction(
  groups: HoverActionGroup[],
  key: string,
  replace: (action: HoverAction) => HoverAction | null,
): HoverActionGroup[] {
  return groups.map((group) => ({
    ...group,
    actions: group.actions.flatMap((action) => {
      if (action.key !== key) return [action];
      const next = replace(action);
      return next ? [next] : [];
    }),
  }));
}

/** The drift-group tree by the drift panel's rules: root first, sub-groups read as "parent / child". */
function driftGroupTree(driftGroups: readonly DriftGroup[]) {
  const groupIds = new Set(driftGroups.map((group) => group.id));
  const children = buildDriftGroupChildren(
    driftGroups.map((group) =>
      group.parentGroupId && !groupIds.has(group.parentGroupId) ? { ...group, parentGroupId: null } : group,
    ),
  );
  const rows: Array<{ group: DriftGroup; path: string }> = [];
  const walk = (parentKey: string, parentPath: string) => {
    for (const group of children.get(parentKey) ?? []) {
      const path = parentPath ? `${parentPath} / ${group.name}` : group.name;
      rows.push({ group, path });
      walk(group.id, path);
    }
  };
  walk(ROOT_GROUP_KEY, '');
  return { rows, groupIds };
}

/** Choices of a group to move into: root, then each group by its path, the current one in effect. */
export function driftGroupMoveChoices({
  current,
  driftGroups,
  blocked,
  rootLabel,
  onMove,
}: {
  current: string | null;
  driftGroups: readonly DriftGroup[];
  /** Groups that cannot be chosen (a group itself and what lies under it). */
  blocked?: ReadonlySet<string>;
  rootLabel: string;
  onMove: (groupId: string | null) => void;
}): HoverAction[] {
  const { rows, groupIds } = driftGroupTree(driftGroups);
  // A pointer at a group that no longer exists (a cross-device sync race)
  // reads as root, as it does in the drift panel.
  const resolved = current && groupIds.has(current) ? current : null;
  return [
    {
      key: 'root',
      label: rootLabel,
      icon: { brush: 'folder-none' },
      active: resolved == null,
      disabled: resolved == null,
      onSelect: () => onMove(null),
    },
    ...rows
      .filter(({ group }) => !blocked?.has(group.id))
      .map(({ group, path }): HoverAction => ({
        key: group.id,
        label: path,
        icon: { kind: 'drift-group', color: group.color ?? undefined },
        active: group.id === resolved,
        disabled: group.id === resolved,
        onSelect: () => onMove(group.id),
      })),
  ];
}

/**
 * A drift card's "Move to group…" unfolds the drift-group tree. With no
 * groups there is nowhere to move, so the action is left out.
 */
export function withDriftGroupChoices(
  groups: HoverActionGroup[],
  { node, driftGroups, onMove, t }: {
    node: BookNode;
    driftGroups: readonly DriftGroup[];
    onMove: (groupId: string | null) => void;
    t: TFunction;
  },
): HoverActionGroup[] {
  return replaceAction(groups, DRIFT_MOVE_TO_GROUP_ACTION, (action) => driftGroups.length > 0
    ? {
        ...action,
        icon: undefined,
        onSelect: undefined,
        choices: driftGroupMoveChoices({
          current: node.driftGroupId ?? null,
          driftGroups,
          rootLabel: t('leftSidebar.groups.moveDriftToRoot'),
          onMove,
        }),
      }
    : null);
}

/**
 * An element's 改类目 unfolds the categories, each led by its sand corner in
 * its own colour, so the move happens where the element is.
 */
export function withElementCategoryChoices(
  groups: HoverActionGroup[],
  { categoryId, categories, onMove }: {
    categoryId: string | null;
    categories: readonly { id: string; name: string; color?: string | null }[];
    onMove: (categoryId: string) => void;
  },
): HoverActionGroup[] {
  const choices: HoverAction[] = categories.map((category) => ({
    key: category.id,
    label: category.name,
    icon: { kind: 'category', color: category.color ?? undefined },
    active: category.id === categoryId,
    disabled: category.id === categoryId,
    onSelect: () => onMove(category.id),
  }));
  return replaceAction(groups, 'categoryPicker', (action) =>
    choices.length > 1 ? { ...action, icon: undefined, onSelect: undefined, choices } : null);
}

/**
 * An element's 改分组 unfolds the groups already named in its category, then
 * no group, then a row that names a new one (the picker, which can type it).
 */
export function withElementGroupChoices(
  groups: HoverActionGroup[],
  { groupName, groupNames, onMove, onNewGroup, t }: {
    groupName: string | null;
    groupNames: readonly string[];
    onMove: (groupName: string | null) => void;
    onNewGroup: () => void;
    t: TFunction;
  },
): HoverActionGroup[] {
  const current = groupName?.trim() || null;
  const choices: HoverAction[] = [
    ...groupNames.map((name): HoverAction => ({
      key: `group:${name}`,
      label: name,
      icon: { brush: 'folder' },
      active: name === current,
      disabled: name === current,
      onSelect: () => onMove(name),
    })),
    {
      key: 'group:none',
      label: t('elementGroupPicker.noGroup'),
      icon: { brush: 'folder-none' },
      active: current == null,
      disabled: current == null,
      onSelect: () => onMove(null),
    },
    {
      key: 'group:new',
      label: t('elementCategoryCreateMenu.newGroup'),
      icon: { brush: 'folder-plus' },
      onSelect: onNewGroup,
    },
  ];
  return replaceAction(groups, 'groupPicker', (action) => ({ ...action, icon: undefined, onSelect: undefined, choices }));
}

/**
 * A chapter's 编辑故事线 unfolds every storyline, each led by its sand dash in
 * its own colour and ticked while the chapter is on it; choosing one puts the
 * chapter on it or takes it off, in place.
 */
export function withChapterStorylineChoices(
  groups: HoverActionGroup[],
  { memberIds, storylines, onToggle }: {
    memberIds: readonly string[];
    storylines: readonly { id: string; name: string; color?: string | null }[];
    onToggle: (storylineId: string) => void;
  },
): HoverActionGroup[] {
  if (storylines.length === 0) return groups;
  const members = new Set(memberIds);
  const choices: HoverAction[] = storylines.map((storyline) => ({
    key: storyline.id,
    label: storyline.name,
    icon: { kind: 'storyline', color: storyline.color ?? undefined },
    checked: members.has(storyline.id),
    keepOpen: true,
    onSelect: () => onToggle(storyline.id),
  }));
  return replaceAction(groups, 'editNodeStorylines', (action) =>
    ({ ...action, icon: undefined, onSelect: undefined, multiple: true, choices }));
}

/** Drifts free to bind to a marker or act, as choices led by their sand eddy. */
export function bindDriftChoices({
  drifts,
  colorOf,
  onBind,
}: {
  drifts: readonly BookNode[];
  colorOf: (drift: BookNode) => string | undefined;
  onBind: (driftId: string) => void;
}): HoverAction[] {
  return drifts.map((drift) => ({
    key: drift.id,
    label: drift.title || drift.id,
    icon: { kind: 'drift', color: colorOf(drift), loose: !drift.driftGroupId },
    onSelect: () => onBind(drift.id),
  }));
}
