import { and, eq } from 'drizzle-orm';

import type { DbExecutor } from '../../lib/db';
import { parseDocId } from '../../lib/yjs-doc-id';
import { SyncEntityLifecycleTable } from '../../schema/drizzle';
import {
  parseProjectAssetMutationV1,
  type SyncMutationAction,
} from '../protocol';
import type {
  PendingSyncMutationViewV1,
  SyncChangeBuilder,
} from './change-builder';

export interface CurrentSyncEntityLifecycle {
  readonly incarnation: number;
  readonly state: 'live' | 'trashed' | 'purged';
}

interface LifecycleOwner {
  readonly kind: string;
  readonly id: string;
}

interface EffectiveLifecycle extends CurrentSyncEntityLifecycle {
  readonly source: 'persisted' | 'transition';
}

const LIFECYCLE_ACTIONS = new Set<SyncMutationAction>([
  'entity.create',
  'entity.trash',
  'entity.restore',
  'entity.purge',
]);

function ownerKey(owner: LifecycleOwner): string {
  return JSON.stringify([owner.kind, owner.id]);
}

function proseOwner(docId: string): LifecycleOwner {
  const parsed = parseDocId(docId);
  if (!parsed || !parsed.entityId) {
    throw new TypeError(`Yjs target ${docId} is not a canonical prose document id`);
  }
  switch (parsed.kind) {
    case 'node-content':
      return { kind: 'node', id: parsed.entityId };
    case 'element':
      return { kind: 'element', id: parsed.entityId };
    case 'storyline':
      return { kind: 'storyline', id: parsed.entityId };
    case 'category':
      return { kind: 'element-category', id: parsed.entityId };
  }
}

/**
 * The wire target may name a derived register rather than its lifecycle owner.
 * This is the single mapping used by authored journal normalization; the
 * reducer carries the same ownership semantics when deciding materialization.
 */
export function lifecycleOwnerForAuthoredMutation(
  mutation: PendingSyncMutationViewV1,
): LifecycleOwner | null {
  const { target } = mutation;
  if (LIFECYCLE_ACTIONS.has(mutation.action)) {
    return { kind: target.kind, id: target.id };
  }
  if (target.family === 'sync-generation') return null;
  if (target.family === 'yjs' || target.kind === 'prose-document') {
    return proseOwner(target.id);
  }
  if (target.family === 'asset' || target.kind === 'project-asset') {
    const parsed = parseProjectAssetMutationV1({
      action: mutation.action,
      target,
      payload: mutation.payload,
    });
    if (!parsed.ok) {
      const detail = parsed.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('; ');
      throw new TypeError(`Cannot resolve asset owner incarnation: ${detail}`);
    }
    const owner = parsed.value.payload.owner;
    return owner.kind === 'element-portrait'
      ? { kind: 'element', id: owner.id }
      : { kind: 'library-item', id: owner.id };
  }
  switch (target.kind) {
    case 'node-content':
    case 'node-storyline-primary':
    case 'chapter':
      return { kind: 'node', id: target.id };
    case 'alias':
      return { kind: 'element', id: target.id };
    case 'membership':
      return { kind: 'storyline', id: target.id };
    default:
      return { kind: target.kind, id: target.id };
  }
}

export async function resolveCurrentEntityLifecycleInTransaction(
  tx: DbExecutor,
  input: {
    readonly syncGenerationId: string;
    readonly kind: string;
    readonly id: string;
  },
): Promise<CurrentSyncEntityLifecycle | null> {
  const rows = await tx
    .select({
      incarnation: SyncEntityLifecycleTable.incarnation,
      state: SyncEntityLifecycleTable.state,
    })
    .from(SyncEntityLifecycleTable)
    .where(
      and(
        eq(SyncEntityLifecycleTable.syncGenerationId, input.syncGenerationId),
        eq(SyncEntityLifecycleTable.entityKind, input.kind),
        eq(SyncEntityLifecycleTable.entityId, input.id),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.state !== 'live' && row.state !== 'trashed' && row.state !== 'purged') {
    throw new Error(`Entity lifecycle ${input.kind}:${input.id} has invalid state ${row.state}`);
  }
  return { incarnation: row.incarnation, state: row.state };
}

async function persistedLifecycles(
  tx: DbExecutor,
  syncGenerationId: string,
  mutations: readonly PendingSyncMutationViewV1[],
): Promise<Map<string, EffectiveLifecycle>> {
  const owners = new Map<string, LifecycleOwner>();
  for (const mutation of mutations) {
    const owner = lifecycleOwnerForAuthoredMutation(mutation);
    if (owner) owners.set(ownerKey(owner), owner);
  }
  const result = new Map<string, EffectiveLifecycle>();
  for (const [key, owner] of owners) {
    const current = await resolveCurrentEntityLifecycleInTransaction(tx, {
      syncGenerationId,
      ...owner,
    });
    if (current) result.set(key, { ...current, source: 'persisted' });
  }
  return result;
}

function lifecycleTransition(
  mutation: PendingSyncMutationViewV1,
  current: EffectiveLifecycle | undefined,
): EffectiveLifecycle {
  const label = `${mutation.target.kind}:${mutation.target.id}`;
  switch (mutation.action) {
    case 'entity.create':
      if (current) {
        throw new Error(`Cannot create ${label}; lifecycle already exists as ${current.state}`);
      }
      return { incarnation: 0, state: 'live', source: 'transition' };
    case 'entity.restore':
      if (!current || current.state !== 'trashed') {
        throw new Error(`Cannot restore ${label}; current lifecycle is not trashed`);
      }
      if (!Number.isSafeInteger(current.incarnation + 1)) {
        throw new RangeError(`Cannot restore ${label}; incarnation overflow`);
      }
      return {
        incarnation: current.incarnation + 1,
        state: 'live',
        source: 'transition',
      };
    case 'entity.trash':
      if (!current || current.state !== 'live') {
        throw new Error(`Cannot trash ${label}; current lifecycle is not live`);
      }
      return { ...current, state: 'trashed', source: 'transition' };
    case 'entity.purge':
      if (!current || current.state === 'purged') {
        throw new Error(`Cannot purge ${label}; current lifecycle is missing or already purged`);
      }
      return { ...current, state: 'purged', source: 'transition' };
    default:
      throw new Error(`${mutation.action} is not an entity lifecycle transition`);
  }
}

/**
 * Replace every authored placeholder with the current owner incarnation. A
 * create/restore transition in this same atomic change-set becomes effective
 * for all of its field/tuple/order/Yjs/asset mutations regardless of append
 * order. Missing lifecycle metadata is tolerated only for non-lifecycle
 * low-level journal fixtures; product create/trash/restore/purge paths fail
 * closed.
 */
export async function normalizeAuthoredIncarnationsInTransaction(
  tx: DbExecutor,
  input: {
    readonly syncGenerationId: string;
    readonly builder: SyncChangeBuilder;
  },
): Promise<void> {
  await input.builder.normalizeTargetIncarnations(async (mutations) => {
    const effective = await persistedLifecycles(tx, input.syncGenerationId, mutations);
    const transitioned = new Set<string>();

    for (const mutation of mutations) {
      if (!LIFECYCLE_ACTIONS.has(mutation.action)) continue;
      const owner = { kind: mutation.target.kind, id: mutation.target.id };
      const key = ownerKey(owner);
      if (transitioned.has(key)) {
        throw new Error(
          `Authored change-set contains multiple lifecycle transitions for ${owner.kind}:${owner.id}`,
        );
      }
      effective.set(key, lifecycleTransition(mutation, effective.get(key)));
      transitioned.add(key);
    }

    return mutations.map((mutation) => {
      const owner = lifecycleOwnerForAuthoredMutation(mutation);
      if (!owner) return mutation.target.incarnation;
      return effective.get(ownerKey(owner))?.incarnation ?? mutation.target.incarnation;
    });
  });
}
