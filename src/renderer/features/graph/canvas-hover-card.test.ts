import { describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';

import type { BookNode } from '../../domain/book-node';
import type { DriftGroup } from '../../domain/drift-group';
import { DRIFT_MOVE_TO_GROUP_ACTION } from '../../components/editor/EditorTopBar';
import type { HoverActionGroup } from '../../components/ui/HoverCard';
import { withDriftGroupChoices } from './canvas-hover-card';

const t = ((key: string) => key) as unknown as TFunction;

const group = (id: string, name: string, parentGroupId: string | null, sortOrder: number): DriftGroup => ({
  id, projectId: 'synthetic', name, parentGroupId, color: null, sortOrder, createdAt: '', updatedAt: '',
});
const drift = (driftGroupId: string | null) => ({ id: 'drift', kind: 'drift', driftGroupId }) as BookNode;
const cardActions = (): HoverActionGroup[] => [
  {
    key: 'actions',
    actions: [
      { key: 'convertDriftToChapter', label: 'convert' },
      { key: DRIFT_MOVE_TO_GROUP_ACTION, label: 'move', onSelect: () => undefined },
      { key: 'deleteNode', label: 'delete', danger: true },
    ],
  },
];
const groups = [group('b', '乙', null, 1), group('a', '甲', null, 0), group('a1', '甲一', 'a', 0)];

describe('drift card move-to-group choices', () => {
  it('unfolds root first, then the tree depth-first with sub-groups as paths, the current one checked', () => {
    const onMove = vi.fn();
    const [actions] = withDriftGroupChoices(cardActions(), { node: drift('a1'), driftGroups: groups, onMove, t });
    const move = actions!.actions.find((action) => action.key === DRIFT_MOVE_TO_GROUP_ACTION)!;

    expect(move.onSelect).toBeUndefined();
    expect(move.choices?.map(({ key, label, active, disabled }) => ({ key, label, active, disabled }))).toEqual([
      { key: 'root', label: 'leftSidebar.groups.moveDriftToRoot', active: false, disabled: false },
      { key: 'a', label: '甲', active: false, disabled: false },
      { key: 'a1', label: '甲 / 甲一', active: true, disabled: true },
      { key: 'b', label: '乙', active: false, disabled: false },
    ]);
    move.choices![0]!.onSelect!();
    move.choices![3]!.onSelect!();
    expect(onMove.mock.calls).toEqual([[null], ['b']]);
  });

  it('treats a pointer at a missing group as root and lifts orphaned sub-groups to the top', () => {
    const [actions] = withDriftGroupChoices(cardActions(), {
      node: drift('gone'),
      driftGroups: [group('orphan', '孤', 'gone', 0)],
      onMove: () => undefined,
      t,
    });
    const move = actions!.actions.find((action) => action.key === DRIFT_MOVE_TO_GROUP_ACTION)!;
    expect(move.choices?.map(({ key, label, disabled }) => ({ key, label, disabled }))).toEqual([
      { key: 'root', label: 'leftSidebar.groups.moveDriftToRoot', disabled: true },
      { key: 'orphan', label: '孤', disabled: false },
    ]);
  });

  it('leaves the action out when there are no groups to move into', () => {
    const [actions] = withDriftGroupChoices(cardActions(), { node: drift(null), driftGroups: [], onMove: () => undefined, t });
    expect(actions!.actions.map((action) => action.key)).toEqual(['convertDriftToChapter', 'deleteNode']);
  });
});
