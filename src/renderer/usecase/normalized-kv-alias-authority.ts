import { and, eq, isNull } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import {
  assertEntityKvOwner,
  entityKvOrderScope,
  type EntityKvEntry,
  type EntityKvOwner,
} from '../domain/entity-kv-entry';
import { encodeAliases } from '../domain/book-element';
import { parseKv, stringifyKv, type KvEntry } from '../domain/kv';
import type { DbExecutor, DbTransaction } from '../lib/db';
import {
  BookElementTable,
  ElementCategoryTable,
  ProjectTable,
  StorylineTable,
  SyncChangeSetTable,
  SyncOrderRegisterTable,
  SyncSetTagTable,
} from '../schema/drizzle';
import { createEntityKvEntryRepository } from '../sqlite-repo/entity-kv-entry-repo';
import {
  appendAuthoredOrderMove,
  appendAuthoredOrderRebalance,
  findActiveSyncGenerationInTransaction,
  planAuthoredOrderMutation,
  resolveCurrentEntityLifecycleInTransaction,
  type SyncChangeBuilder,
} from '../sync/journal';
import {
  compareSyncTotalOrder,
  compareUtf8Bytewise,
  decodeCanonicalCbor,
  type SyncTotalOrderV1,
} from '../sync/protocol';

async function activeSyncGenerationId(
  tx: DbExecutor,
  projectId: string,
): Promise<string | null> {
  return (
    await findActiveSyncGenerationInTransaction(tx as DbTransaction, projectId)
  )?.syncGenerationId ?? null;
}

async function currentKvPositions(
  tx: DbExecutor,
  owner: EntityKvOwner,
  explicitSyncGenerationId?: string,
): Promise<Map<string, string>> {
  const syncGenerationId =
    explicitSyncGenerationId ?? (await activeSyncGenerationId(tx, owner.projectId));
  if (!syncGenerationId) return new Map();
  const rows = await tx
    .select({
      entityId: SyncOrderRegisterTable.entityId,
      positionKey: SyncOrderRegisterTable.positionKey,
    })
    .from(SyncOrderRegisterTable)
    .where(
      and(
        eq(SyncOrderRegisterTable.syncGenerationId, syncGenerationId),
        eq(SyncOrderRegisterTable.listKind, 'kv-entry'),
        eq(SyncOrderRegisterTable.ownerId, entityKvOrderScope(owner)),
        eq(SyncOrderRegisterTable.incarnation, 0),
      ),
    );
  return new Map(rows.map((row) => [row.entityId, row.positionKey]));
}

async function orderedKvEntries(
  tx: DbExecutor,
  owner: EntityKvOwner,
  explicitSyncGenerationId?: string,
): Promise<EntityKvEntry[]> {
  assertEntityKvOwner(owner);
  const rows = await createEntityKvEntryRepository(owner.projectId, tx).list(owner);
  if (rows.length === 0) return [];
  const positions = await currentKvPositions(tx, owner, explicitSyncGenerationId);
  const missing = rows.filter((row) => !positions.has(row.id));
  if (missing.length > 0) {
    throw new Error(
      `KV authority ${entityKvOrderScope(owner)} has ${missing.length} row(s) without order registers`,
    );
  }
  return [...rows].sort(
    (left, right) =>
      compareUtf8Bytewise(positions.get(left.id)!, positions.get(right.id)!) ||
      compareUtf8Bytewise(left.id, right.id),
  );
}

function cleanedKv(raw: string): KvEntry[] {
  return parseKv(stringifyKv(parseKv(raw)));
}

function reconcileKvEntryIds(
  existing: readonly EntityKvEntry[],
  desired: readonly KvEntry[],
): Array<KvEntry & { id: string }> {
  const unused = new Set(existing.map((entry) => entry.id));
  const matches: Array<EntityKvEntry | undefined> = desired.map(() => undefined);
  const assign = (predicate: (candidate: EntityKvEntry, entry: KvEntry) => boolean) => {
    for (let index = 0; index < desired.length; index += 1) {
      if (matches[index]) continue;
      const entry = desired[index];
      const matched = existing.find(
        (candidate) => unused.has(candidate.id) && predicate(candidate, entry),
      );
      if (!matched) continue;
      matches[index] = matched;
      unused.delete(matched.id);
    }
  };

  // Reserve every semantically identifiable row before considering slot
  // identity. This prevents an inserted or moved-and-edited row from stealing
  // the ID of an exact row that appears later in the desired list.
  assign(
    (candidate, entry) => candidate.key === entry.key && candidate.value === entry.value,
  );
  assign((candidate, entry) => candidate.key === entry.key);

  // A same-slot fallback represents an in-place key rename. It is safe only
  // when cardinality is unchanged; after an insertion/deletion, an anonymous
  // JSON row has no identity signal and receives a fresh ID instead of
  // guessing and shifting identities across the list.
  if (existing.length === desired.length) {
    for (let index = 0; index < desired.length; index += 1) {
      if (matches[index]) continue;
      const candidate = existing[index];
      if (!candidate || !unused.has(candidate.id)) continue;
      matches[index] = candidate;
      unused.delete(candidate.id);
    }
  }

  return desired.map((entry, index) => ({
    id: matches[index]?.id ?? uuidv7(),
    key: entry.key,
    value: entry.value,
  }));
}

async function writeKvProjection(
  tx: DbExecutor,
  owner: EntityKvOwner,
  projectionJson: string,
): Promise<void> {
  let rows: Array<{ id: string }>;
  switch (`${owner.ownerKind}:${owner.namespace}`) {
    case 'project:facts':
      rows = await tx
        .update(ProjectTable)
        .set({ kvJson: projectionJson })
        .where(and(eq(ProjectTable.id, owner.ownerId), eq(ProjectTable.id, owner.projectId)))
        .returning({ id: ProjectTable.id });
      break;
    case 'project:storyline-template':
      rows = await tx
        .update(ProjectTable)
        .set({ storylineTemplateKvJson: projectionJson })
        .where(and(eq(ProjectTable.id, owner.ownerId), eq(ProjectTable.id, owner.projectId)))
        .returning({ id: ProjectTable.id });
      break;
    case 'storyline:facts':
      rows = await tx
        .update(StorylineTable)
        .set({ kvJson: projectionJson })
        .where(
          and(
            eq(StorylineTable.id, owner.ownerId),
            eq(StorylineTable.projectId, owner.projectId),
          ),
        )
        .returning({ id: StorylineTable.id });
      break;
    case 'element-category:element-template':
      rows = await tx
        .update(ElementCategoryTable)
        .set({ elementTemplateKvJson: projectionJson })
        .where(
          and(
            eq(ElementCategoryTable.id, owner.ownerId),
            eq(ElementCategoryTable.projectId, owner.projectId),
          ),
        )
        .returning({ id: ElementCategoryTable.id });
      break;
    case 'element:facts':
      rows = await tx
        .update(BookElementTable)
        .set({ kvJson: projectionJson })
        .where(
          and(
            eq(BookElementTable.id, owner.ownerId),
            eq(BookElementTable.projectId, owner.projectId),
          ),
        )
        .returning({ id: BookElementTable.id });
      break;
    default:
      assertEntityKvOwner(owner);
      throw new TypeError(`Unsupported KV projection ${owner.ownerKind}:${owner.namespace}`);
  }
  if (rows.length !== 1) {
    throw new Error(`KV projection owner ${owner.ownerKind}:${owner.ownerId} does not exist`);
  }
}

/**
 * Reconcile one legacy JSON projection into stable KV entities. Authority rows,
 * lifecycle/LWW mutations, order registers and the rebuilt projection all live
 * in the caller-owned authored transaction.
 */
export async function replaceEntityKvEntriesInTransaction(
  tx: DbExecutor,
  changes: SyncChangeBuilder,
  input: EntityKvOwner & { readonly nextJson: string },
): Promise<string> {
  assertEntityKvOwner(input);
  const repo = createEntityKvEntryRepository(input.projectId, tx);
  const existing = await orderedKvEntries(tx, input);
  const positions = await currentKvPositions(tx, input);
  const desired = reconcileKvEntryIds(existing, cleanedKv(input.nextJson));
  const desiredIds = new Set(desired.map((entry) => entry.id));
  const existingById = new Map(existing.map((entry) => [entry.id, entry]));
  const scope = entityKvOrderScope(input);

  for (const current of existing) {
    if (desiredIds.has(current.id)) continue;
    await repo.remove(current.id);
    changes.add({
      action: 'entity.purge',
      target: { family: 'entity', kind: 'kv-entry', id: current.id, incarnation: 0 },
      payload: {},
    });
  }

  for (let index = 0; index < desired.length; index += 1) {
    const entry = desired[index];
    const current = existingById.get(entry.id);
    if (!current) {
      const created: EntityKvEntry = {
        id: entry.id,
        projectId: input.projectId,
        ownerKind: input.ownerKind,
        ownerId: input.ownerId,
        namespace: input.namespace,
        key: entry.key,
        value: entry.value,
      };
      await repo.create(created);
      changes.add({
        action: 'entity.create',
        target: { family: 'entity', kind: 'kv-entry', id: entry.id, incarnation: 0 },
        payload: {
          seed: {
            projectId: input.projectId,
            ownerKind: input.ownerKind,
            ownerId: input.ownerId,
            namespace: input.namespace,
            key: entry.key,
            value: entry.value,
          },
        },
      });
    } else if (current.key !== entry.key || current.value !== entry.value) {
      await repo.update(entry.id, { key: entry.key, value: entry.value });
      if (current.key !== entry.key) {
        changes.add({
          action: 'field.set',
          target: { family: 'entity', kind: 'kv-entry', id: entry.id, incarnation: 0 },
          payload: { field: 'key', value: entry.key },
        });
      }
      if (current.value !== entry.value) {
        changes.add({
          action: 'field.set',
          target: { family: 'entity', kind: 'kv-entry', id: entry.id, incarnation: 0 },
          payload: { field: 'value', value: entry.value },
        });
      }
    }

  }

  const orderPlan = planAuthoredOrderMutation(
    [...positions].map(([entityId, positionKey]) => ({ entityId, positionKey })),
    desired.map(({ id }) => id),
  );
  if (orderPlan.kind === 'rebalance') {
    appendAuthoredOrderRebalance(changes, {
      listKind: 'kv-entry',
      scope,
      entries: orderPlan.entries,
    });
  } else {
    for (const entry of orderPlan.entries) {
      appendAuthoredOrderMove(changes, {
        listKind: 'kv-entry',
        scope,
        entityId: entry.entityId,
        positionKey: entry.positionKey,
      });
    }
  }

  const projectionJson = stringifyKv(desired.map(({ key, value }) => ({ key, value })));
  await writeKvProjection(tx, input, projectionJson);
  return projectionJson;
}

export async function cloneEntityKvEntriesInTransaction(
  tx: DbExecutor,
  changes: SyncChangeBuilder,
  input: {
    readonly source: EntityKvOwner;
    readonly target: EntityKvOwner;
  },
): Promise<string> {
  const source = await orderedKvEntries(tx, input.source);
  return replaceEntityKvEntriesInTransaction(tx, changes, {
    ...input.target,
    nextJson: stringifyKv(source.map(({ key, value }) => ({ key, value }))),
  });
}

export async function materializeEntityKvProjectionInTransaction(
  tx: DbExecutor,
  owner: EntityKvOwner,
  options: { readonly syncGenerationId?: string } = {},
): Promise<string> {
  const entries = await orderedKvEntries(tx, owner, options.syncGenerationId);
  const projectionJson = stringifyKv(entries.map(({ key, value }) => ({ key, value })));
  await writeKvProjection(tx, owner, projectionJson);
  return projectionJson;
}

export function normalizeAliasValue(value: string): string {
  return value.trim().normalize('NFKC').toLowerCase();
}

interface LiveAliasMember {
  readonly display: string;
  readonly addTags: readonly string[];
}

async function liveAliasMembers(
  tx: DbExecutor,
  projectId: string,
  elementId: string,
  explicitSyncGenerationId?: string,
): Promise<Map<string, LiveAliasMember>> {
  const syncGenerationId =
    explicitSyncGenerationId ?? (await activeSyncGenerationId(tx, projectId));
  if (!syncGenerationId) return new Map();
  const lifecycle = await resolveCurrentEntityLifecycleInTransaction(tx, {
    syncGenerationId,
    kind: 'element',
    id: elementId,
  });
  if (lifecycle && lifecycle.state !== 'live') return new Map();
  const incarnation = lifecycle?.incarnation ?? 0;
  const rows = await tx
    .select({
      valueKey: SyncSetTagTable.valueKey,
      valueCbor: SyncSetTagTable.valueCbor,
      addTag: SyncSetTagTable.addTag,
      hlcWallMs: SyncChangeSetTable.hlcWallMs,
      hlcCounter: SyncChangeSetTable.hlcCounter,
      writerId: SyncChangeSetTable.writerId,
      writerEpoch: SyncChangeSetTable.writerEpoch,
      deviceSeq: SyncChangeSetTable.deviceSeq,
      mutationIndex: SyncSetTagTable.addMutationIndex,
    })
    .from(SyncSetTagTable)
    .innerJoin(
      SyncChangeSetTable,
      eq(SyncChangeSetTable.changeSetId, SyncSetTagTable.addChangeSetId),
    )
    .where(
      and(
        eq(SyncSetTagTable.syncGenerationId, syncGenerationId),
        eq(SyncSetTagTable.ownerKind, 'alias'),
        eq(SyncSetTagTable.ownerId, elementId),
        eq(SyncSetTagTable.incarnation, incarnation),
        eq(SyncSetTagTable.setKey, 'aliases'),
        isNull(SyncSetTagTable.removedByChangeSetId),
      ),
    );
  const grouped = new Map<
    string,
    Array<{ display: string; addTag: string; order: SyncTotalOrderV1 }>
  >();
  for (const row of rows) {
    const decoded = decodeCanonicalCbor(row.valueCbor as Uint8Array);
    if (!decoded.ok || typeof decoded.value !== 'string') {
      throw new Error(`Alias tag ${row.addTag} has invalid canonical value`);
    }
    const values = grouped.get(row.valueKey) ?? [];
    values.push({
      display: decoded.value,
      addTag: row.addTag,
      order: {
        hlc: { wallMs: row.hlcWallMs, counter: row.hlcCounter },
        writerId: row.writerId,
        writerEpoch: row.writerEpoch,
        deviceSeq: row.deviceSeq,
        mutationIndex: row.mutationIndex,
      },
    });
    grouped.set(row.valueKey, values);
  }
  return new Map(
    [...grouped].map(([valueKey, values]) => {
      values.sort(
        (left, right) =>
          compareSyncTotalOrder(left.order, right.order) ||
          compareUtf8Bytewise(left.addTag, right.addTag),
      );
      return [
        valueKey,
        {
          display: values[values.length - 1]!.display,
          addTags: values.map(({ addTag }) => addTag),
        },
      ];
    }),
  );
}

function desiredAliases(values: readonly string[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const value of values) {
    const display = value.trim().normalize('NFKC');
    const normalized = normalizeAliasValue(display);
    if (normalized) aliases.set(normalized, display);
  }
  return new Map([...aliases].sort(([left], [right]) => compareUtf8Bytewise(left, right)));
}

async function writeAliasesProjection(
  tx: DbExecutor,
  projectId: string,
  elementId: string,
  aliases: readonly string[],
): Promise<void> {
  const rows = await tx
    .update(BookElementTable)
    .set({ aliasesJson: encodeAliases([...aliases]) })
    .where(
      and(eq(BookElementTable.id, elementId), eq(BookElementTable.projectId, projectId)),
    )
    .returning({ id: BookElementTable.id });
  if (rows.length !== 1) throw new Error(`Alias projection element ${elementId} does not exist`);
}

export async function replaceElementAliasesInTransaction(
  tx: DbExecutor,
  changes: SyncChangeBuilder,
  input: {
    readonly projectId: string;
    readonly elementId: string;
    readonly aliases: readonly string[];
    /** Seed a new element incarnation without observing tags from n. */
    readonly forceReincarnation?: boolean;
  },
): Promise<string[]> {
  const current = input.forceReincarnation
    ? new Map<string, LiveAliasMember>()
    : await liveAliasMembers(tx, input.projectId, input.elementId);
  const desired = desiredAliases(input.aliases);
  const target = {
    family: 'set' as const,
    kind: 'alias',
    id: input.elementId,
    incarnation: 0,
  };

  for (const [memberId, member] of current) {
    const nextDisplay = desired.get(memberId);
    if (nextDisplay === member.display) continue;
    changes.add({
      action: 'set.remove',
      target,
      payload: { memberId, observedAddTags: [...member.addTags] },
    });
  }
  for (const [memberId, display] of desired) {
    if (current.get(memberId)?.display === display) continue;
    changes.add({ action: 'set.add', target, payload: { memberId, value: display } });
  }

  const projection = [...desired.values()];
  await writeAliasesProjection(tx, input.projectId, input.elementId, projection);
  return projection;
}

export async function materializeElementAliasesProjectionInTransaction(
  tx: DbExecutor,
  projectId: string,
  elementId: string,
  options: { readonly syncGenerationId?: string } = {},
): Promise<string[]> {
  const live = await liveAliasMembers(
    tx,
    projectId,
    elementId,
    options.syncGenerationId,
  );
  const aliases = [...live]
    .sort(([left], [right]) => compareUtf8Bytewise(left, right))
    .map(([, member]) => member.display);
  await writeAliasesProjection(tx, projectId, elementId, aliases);
  return aliases;
}
