import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { TFunction } from 'i18next';

import type { BookNode } from '../../domain/book-node';
import { buildDriftGroupChildren, ROOT_GROUP_KEY, type DriftGroup } from '../../domain/drift-group';
import { DRIFT_MOVE_TO_GROUP_ACTION } from '../../components/editor/EditorTopBar';
import type { HoverAction, HoverActionGroup } from '../../components/ui/HoverCard';
import { useHoverPreview, type EntityHoverTarget } from '../entities/hover/entity-hover-card-model';

/**
 * Hover-card state for the Super View canvases, where the cards carry what
 * the right-click menus used to. While `blocked` (a click popover, link
 * picking, a relation dialog) no card opens; the owner dismisses a showing
 * card when a press, drag or pan starts.
 */
export function useCanvasHoverCard(blocked: boolean) {
  const hover = useHoverPreview<EntityHoverTarget>();
  const { preview, onEnter } = hover;

  // Read through a ref so `onEnter` stays stable: memoized lane rows and
  // cards should not re-render because a popover opened.
  const blockedRef = useRef(blocked);
  useLayoutEffect(() => {
    blockedRef.current = blocked;
  }, [blocked]);
  const enter = useCallback(
    (target: EntityHoverTarget, anchor: HTMLElement) => {
      if (!blockedRef.current) onEnter(target, anchor);
    },
    [onEnter],
  );

  // The card closes itself on Escape, but the Super View's Escape stack (on
  // window) would then also close the layer behind it, or the whole view.
  // Claiming the press before either listener runs keeps it to the card.
  useEffect(() => {
    if (!preview) return undefined;
    const claimEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') event.preventDefault();
    };
    window.addEventListener('keydown', claimEscape, true);
    return () => window.removeEventListener('keydown', claimEscape, true);
  }, [preview]);

  return { ...hover, onEnter: enter };
}

/**
 * A drift card's "Move to group…" unfolds the drift-group tree in place, by
 * the drift panel's rules: root first, sub-groups read as "parent / child",
 * the current one checked. With no groups there is nowhere to move, so the
 * action is left out.
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
  const choices = driftGroups.length > 0 ? driftGroupChoices(node, driftGroups, onMove, t) : null;
  return groups.map((group) => ({
    ...group,
    actions: group.actions.flatMap((action) => {
      if (action.key !== DRIFT_MOVE_TO_GROUP_ACTION) return [action];
      return choices ? [{ ...action, onSelect: undefined, choices }] : [];
    }),
  }));
}

function driftGroupChoices(
  node: BookNode,
  driftGroups: readonly DriftGroup[],
  onMove: (groupId: string | null) => void,
  t: TFunction,
): HoverAction[] {
  const groupIds = new Set(driftGroups.map((group) => group.id));
  // A pointer at a group that no longer exists (a cross-device sync race)
  // reads as root, as it does in the drift panel.
  const current = node.driftGroupId && groupIds.has(node.driftGroupId) ? node.driftGroupId : null;
  const children = buildDriftGroupChildren(
    driftGroups.map((group) =>
      group.parentGroupId && !groupIds.has(group.parentGroupId) ? { ...group, parentGroupId: null } : group,
    ),
  );
  const choices: HoverAction[] = [
    {
      key: 'root',
      label: t('leftSidebar.groups.moveDriftToRoot'),
      active: current == null,
      disabled: current == null,
      onSelect: () => onMove(null),
    },
  ];
  const walk = (parentKey: string, parentPath: string) => {
    for (const group of children.get(parentKey) ?? []) {
      const path = parentPath ? `${parentPath} / ${group.name}` : group.name;
      choices.push({
        key: group.id,
        label: path,
        active: group.id === current,
        disabled: group.id === current,
        onSelect: () => onMove(group.id),
      });
      walk(group.id, path);
    }
  };
  walk(ROOT_GROUP_KEY, '');
  return choices;
}
