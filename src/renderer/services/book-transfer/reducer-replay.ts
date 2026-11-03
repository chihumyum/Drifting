// An imported book is a new project, so its journal starts empty: the source's
// change-sets name the original ids in hashed bytes and cannot be re-keyed.
// Instead the source's canonical reducer state, already compacted to what is
// current, is replayed as this installation's own authored mutations with the
// ids rewritten (docs/book-transfer.md). The SQLite rows come from the
// package; these mutations give them the lifecycle, clock, order and set
// metadata a local write would have left.
import type { SyncMutationDraftV1 } from '../../sync/journal';
import {
  compareSyncTotalOrder,
  parseProjectAssetMutationV1,
  type CanonicalCborValue,
  type SyncMutationTargetV1,
} from '../../sync/protocol';
import {
  lifecycleOwnerTarget,
  reducerLifecycleKey,
  resolvedLifecycle,
  type CanonicalReducerState,
  type ResolvedLifecycle,
} from '../../sync/reducer';
import type { SnapshotTableRowsV1 } from '../../sync/checkpoint/types';
import type { BookIdRewriter } from './id-rewriter';

/** Where each lifecycle kind keeps its row; a trashed kind without one has none left. */
const LIFECYCLE_ROWS: Readonly<Record<string, readonly [table: string, column: string]>> = {
  project: ['project', 'id'],
  node: ['book_node', 'id'],
  'node-content': ['node_content', 'node_id'],
  storyline: ['storylines', 'id'],
  element: ['element', 'id'],
  'element-category': ['element_category', 'id'],
  'element-patch': ['element_patch', 'id'],
  'library-item': ['library_item', 'id'],
  'entity-relation': ['entity_relation', 'id'],
  'entity-relation-type': ['entity_relation_type', 'id'],
  comment: ['comment', 'id'],
  'comment-action': ['comment_action', 'id'],
  'agent-memory': ['agent_memory', 'id'],
  'book-act': ['book_act', 'id'],
  'drift-group': ['drift_group', 'id'],
  'material-folder': ['material_folder', 'id'],
  'writing-day': ['writing_day', 'id'],
  'timeline-marker': ['timeline_marker', 'id'],
  'kv-entry': ['entity_kv_entry', 'id'],
  'plot-grid-row': ['plot_grid_row', 'id'],
  'plot-grid-column': ['plot_grid_column', 'id'],
  'plot-grid-cell': ['plot_grid_cell', 'id'],
};

export interface BookReplayPlan {
  /** Change-set 1: every create, then the registers that describe it. */
  readonly creates: readonly SyncMutationDraftV1[];
  /**
   * Change-set 2: entities in the source's trash. One change-set may carry
   * only one lifecycle transition per entity, so they are created live first.
   */
  readonly trashes: readonly SyncMutationDraftV1[];
  /** Whether the copy carries this (rewritten) lifecycle owner. */
  carries(kind: string, id: string): boolean;
}

function ownerKey(kind: string, id: string): string {
  return reducerLifecycleKey(kind, id);
}

function entityTarget(
  target: Pick<SyncMutationTargetV1, 'kind' | 'id'>,
  rewriter: BookIdRewriter,
) {
  return { family: 'entity' as const, kind: target.kind, id: rewriter.string(target.id), incarnation: 0 };
}

export function planBookReplay(
  state: CanonicalReducerState,
  rewrittenTables: readonly SnapshotTableRowsV1[],
  rewriter: BookIdRewriter,
): BookReplayPlan {
  if (state.generationPurge) throw new Error('A purged project cannot be imported');
  const rows = new Map<string, Set<string>>();
  for (const { table, rows: tableRows } of rewrittenTables) {
    for (const [kind, [rowTable, column]] of Object.entries(LIFECYCLE_ROWS)) {
      if (rowTable !== table) continue;
      rows.set(kind, new Set(tableRows.map((row) => String(row[column]))));
    }
  }

  const creates: SyncMutationDraftV1[] = [];
  const trashes: SyncMutationDraftV1[] = [];
  // Keyed by the source ids: registers are decided before they are rewritten.
  const carried = new Map<string, ResolvedLifecycle>();
  const carriedRewritten = new Set<string>();
  const knownRewritten = new Set<string>();
  for (const lifecycle of state.lifecycles.values()) {
    const location = LIFECYCLE_ROWS[lifecycle.kind];
    if (!location) throw new Error(`Book import does not know lifecycle kind ${lifecycle.kind}`);
    const id = rewriter.string(lifecycle.entityId);
    knownRewritten.add(ownerKey(lifecycle.kind, id));
    const resolved = resolvedLifecycle(lifecycle);
    if (resolved.status !== 'live' && resolved.status !== 'trashed') continue;
    if (!rows.get(lifecycle.kind)?.has(id)) continue;
    let seed = rewriter.value(resolved.seed!.value) as Record<string, CanonicalCborValue>;
    // The copy arrives on the shelf, never in the trash.
    if (lifecycle.kind === 'project' && 'deletedAt' in seed) seed = { ...seed, deletedAt: null };
    const target = entityTarget({ kind: lifecycle.kind, id: lifecycle.entityId }, rewriter);
    creates.push({ action: 'entity.create', target, payload: { seed } });
    if (resolved.status === 'trashed') {
      trashes.push({ action: 'entity.trash', target: { ...target }, payload: {} });
    }
    carried.set(ownerKey(lifecycle.kind, lifecycle.entityId), resolved);
    carriedRewritten.add(ownerKey(lifecycle.kind, id));
  }

  const carriesOwner = (kind: string, id: string, incarnation: number | null): boolean => {
    const key = ownerKey(kind, id);
    if (!state.lifecycles.has(key)) return true;
    const resolved = carried.get(key);
    return resolved !== undefined && (incarnation === null || resolved.incarnation === incarnation);
  };
  const carriesTarget = (target: SyncMutationTargetV1): boolean => {
    const owner = lifecycleOwnerTarget(target);
    return owner === null || carriesOwner(owner.kind, owner.id, target.incarnation);
  };

  for (const register of state.tuples.values()) {
    if (!carriesTarget(register.target)) continue;
    creates.push({
      action: 'tuple.set',
      target: entityTarget(register.target, rewriter),
      payload: { tuple: register.tuple, value: rewriter.value(register.value) },
    });
  }
  for (const register of state.fields.values()) {
    if (!carriesTarget(register.target)) continue;
    if (register.target.kind === 'project' && register.field === 'deletedAt') continue;
    creates.push({
      action: 'field.set',
      target: entityTarget(register.target, rewriter),
      payload: { field: register.field, value: rewriter.value(register.value) },
    });
  }
  for (const set of state.sets.values()) {
    if (!carriesTarget(set.target)) continue;
    for (const member of set.members.values()) {
      // A storyline's membership names its chapters, which must come along.
      if (set.target.kind === 'membership' && !carried.has(ownerKey('node', member.memberId))) continue;
      const visible = [...member.adds.values()]
        .filter((add) => !member.removedAddTags.has(add.tag))
        .sort((left, right) => compareSyncTotalOrder(left.order, right.order));
      const winner = visible[visible.length - 1];
      if (!winner) continue;
      creates.push({
        action: 'set.add',
        target: { family: 'set', kind: set.target.kind, id: rewriter.string(set.target.id), incarnation: 0 },
        payload: { memberId: rewriter.string(member.memberId), value: rewriter.value(winner.value) },
      });
    }
  }
  for (const register of state.orders.values()) {
    if (!carriesTarget(register.target)) continue;
    creates.push({
      action: 'order.move',
      target: { family: 'order', kind: register.target.kind, id: rewriter.string(register.target.id), incarnation: 0 },
      payload: { scope: rewriter.string(register.scope), positionKey: register.value },
    });
  }
  for (const register of state.assetBindings.values()) {
    if (register.value.action !== 'asset.bind') continue;
    const parsed = parseProjectAssetMutationV1({
      action: register.value.action,
      target: register.target,
      payload: register.value.payload,
    });
    if (!parsed.ok || parsed.value.action !== 'asset.bind') {
      throw new Error(`Asset binding ${register.target.id} is malformed`);
    }
    const owner = parsed.value.payload.owner;
    const ownerKind = owner.kind === 'element-portrait' ? 'element' : 'library-item';
    if (!carriesOwner(ownerKind, owner.id, register.target.incarnation)) continue;
    const assetId = rewriter.string(register.target.id);
    if (!rewrittenTables.find((entry) => entry.table === 'project_asset')?.rows.some((row) => row.id === assetId)) {
      continue;
    }
    creates.push({
      action: 'asset.bind',
      target: { family: 'asset', kind: 'project-asset', id: assetId, incarnation: 0 },
      payload: rewriter.value(register.value.payload),
    });
  }

  return {
    creates,
    trashes,
    carries: (kind, id) => {
      const key = ownerKey(kind, id);
      return carriedRewritten.has(key) || !knownRewritten.has(key);
    },
  };
}
