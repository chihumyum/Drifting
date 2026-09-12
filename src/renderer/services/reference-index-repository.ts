import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import * as Y from 'yjs';

import { isStructuralEntityKind, type StructuralEntityKind } from '../domain/entity-kinds';
import type { DbClient, DbTransaction } from '../lib/db';
import { isProseEntityType, proseDocId } from '../lib/yjs-doc-id';
import {
  BookElementTable, BookNodeTable, ElementCategoryTable, ElementPatchTable,
  InlineMentionTable, NodeContentTable, ProjectTable, StorylineTable,
} from '../schema/drizzle';
import { createInlineMentionRepository, type InlineMentionDraft } from '../sqlite-repo/inline-mention-repo';
import { createYjsRepository } from '../sqlite-repo/yjs-repo';
import {
  findActiveSyncGenerationInTransaction,
  type ActiveSyncGenerationIdentity,
} from '../sync/journal/sync-generation-repository';
import { trackAtomicSyncTransaction } from './atomic-sync-transaction-tracker';
import { projectInlineMentionsFromJson } from './reference-projection.service';

const scopeOwner = Symbol('reference-index-owner');

export interface ReferenceSourceId {
  readonly kind: StructuralEntityKind;
  readonly id: string;
}

export interface ReferenceSourceVersion extends ReferenceSourceId {
  readonly createdAt: string;
  readonly basis:
    | { readonly kind: 'yjs'; readonly revision: number; readonly hasState: boolean }
    | { readonly kind: 'json'; readonly contentJson: string | null };
}

export interface ReferenceIndexScope {
  readonly [scopeOwner]: object;
  readonly projectId: string;
  readonly projectCreatedAt: string;
  readonly generation: ActiveSyncGenerationIdentity | null;
}

export interface ReferenceIndexCatalog {
  readonly scope: ReferenceIndexScope;
  readonly sources: readonly ReferenceSourceVersion[];
  readonly indexedCounts: ReadonlyMap<string, number>;
}

export interface PreparedReferenceSource {
  readonly scope: ReferenceIndexScope;
  readonly source: ReferenceSourceVersion;
  readonly drafts: readonly InlineMentionDraft[];
}

interface SourceRow extends ReferenceSourceId {
  createdAt: string;
  contentJson: string | null;
}

export class ReferenceIndexOwnerInactiveError extends Error {
  constructor() {
    super('Reference index owner is no longer active.');
    this.name = 'ReferenceIndexOwnerInactiveError';
  }
}

export function sameReferenceIndexScope(left: ReferenceIndexScope, right: ReferenceIndexScope): boolean {
  return left[scopeOwner] === right[scopeOwner]
    && left.projectId === right.projectId
    && left.projectCreatedAt === right.projectCreatedAt
    && left.generation?.projectSyncId === right.generation?.projectSyncId
    && left.generation?.syncGenerationId === right.generation?.syncGenerationId
    && left.generation?.generationNumber === right.generation?.generationNumber;
}

/** Ignore derived contentJson, titles, metrics and layout once Yjs owns prose. */
export function sameReferenceSourceVersion(left: ReferenceSourceVersion, right: ReferenceSourceVersion): boolean {
  if (left.kind !== right.kind || left.id !== right.id || left.createdAt !== right.createdAt) return false;
  if (left.basis.kind === 'yjs' && right.basis.kind === 'yjs') {
    return left.basis.revision === right.basis.revision && left.basis.hasState === right.basis.hasState;
  }
  return left.basis.kind === 'json' && right.basis.kind === 'json'
    && left.basis.contentJson === right.basis.contentJson;
}

/**
 * Bound to one captured database and one project owner. The caller must revoke
 * isCurrent on disposal/database replacement. No late getDb(), live-doc flush,
 * authored write, event emission or durable cache is hidden in this boundary.
 * The project reference queue owns the versions and the retry lifecycle.
 */
export function createReferenceIndexRepository(options: {
  database: DbClient;
  projectId: string;
  isCurrent: () => boolean;
}) {
  const { database, projectId, isCurrent } = options;
  const owner = {};
  const assertCurrent = () => {
    if (!isCurrent()) throw new ReferenceIndexOwnerInactiveError();
  };
  const transaction = <T>(work: (tx: DbTransaction) => Promise<T>, write = false): Promise<T> => {
    assertCurrent();
    const operation = database.transaction(async (tx) => {
      // The transaction scheduler may have waited behind an authored write.
      assertCurrent();
      const result = await work(tx);
      // Revocation during any awaited SQL rolls back, including delete/insert.
      assertCurrent();
      return result;
    });
    if (write) {
      // Lifecycle drains must wait for these writes to settle, but a handled
      // derived-index failure must not fail a concurrent workspace refresh.
      // The original rejection still reaches this repository's queue owner.
      void trackAtomicSyncTransaction(operation.then(() => undefined, () => undefined));
    }
    return operation;
  };

  async function readScope(tx: DbTransaction): Promise<ReferenceIndexScope | null> {
    const [project] = await tx.select({ createdAt: ProjectTable.createdAt })
      .from(ProjectTable).where(eq(ProjectTable.id, projectId)).limit(1);
    if (!project) return null;
    const generation = await findActiveSyncGenerationInTransaction(tx, projectId);
    return { [scopeOwner]: owner, projectId, projectCreatedAt: project.createdAt, generation };
  }

  async function scopeIsCurrent(tx: DbTransaction, scope: ReferenceIndexScope): Promise<boolean> {
    if (scope[scopeOwner] !== owner) return false;
    const current = await readScope(tx);
    return current !== null && sameReferenceIndexScope(scope, current);
  }

  async function readCurrentSource(tx: DbTransaction, id: ReferenceSourceId): Promise<ReferenceSourceVersion | null> {
    const [row] = await loadSourceRows(tx, projectId, id);
    if (!row) return null;
    if (!isProseEntityType(row.kind)) return sourceVersion(row);
    const repo = createYjsRepository(tx);
    const docId = proseDocId(row.kind, row.id);
    const revision = await repo.getRevision(docId);
    const hasState = await repo.hasDocState(docId);
    return sourceVersion(row, revision, hasState);
  }

  async function captureCatalog(only?: readonly ReferenceSourceId[]): Promise<ReferenceIndexCatalog | null> {
    if (only?.length === 0) throw new Error('A scoped reference capture requires at least one source.');
    return transaction(async (tx) => {
      const scope = await readScope(tx);
      if (!scope) return null;
      const rows = await loadSourceRows(tx, projectId, only);
      // Startup/repair reads complete metadata; selected capture batches only
      // the actual source IDs, with no per-source query loop or snapshot blobs.
      const docIds = only ? rows.flatMap((row) => isProseEntityType(row.kind) ? [proseDocId(row.kind, row.id)] : []) : undefined;
      const repo = createYjsRepository(tx);
      const revisions = new Map((await repo.listRevisions(docIds)).map((row) => [row.docId, row.revision]));
      const documents = new Set(await repo.listDocIds(docIds));
      const sources = rows.map((row) => {
        if (!isProseEntityType(row.kind)) return sourceVersion(row);
        const docId = proseDocId(row.kind, row.id);
        return sourceVersion(row, revisions.get(docId) ?? 0, documents.has(docId));
      });
      const indexed = await tx.select({ kind: InlineMentionTable.fromKind, id: InlineMentionTable.fromId, count: sql<number>`count(*)` })
        .from(InlineMentionTable).where(and(eq(InlineMentionTable.projectId, projectId), only
          ? or(...only.map((id) => and(eq(InlineMentionTable.fromKind, id.kind), eq(InlineMentionTable.fromId, id.id))))
          : undefined))
        .groupBy(InlineMentionTable.fromKind, InlineMentionTable.fromId);
      // Existing lifecycle commands can remove rows for a deleted target.
      // Such deletions invalidate coverage even if the source prose is unchanged.
      const indexedCounts = new Map(indexed.map((row) => [referenceSourceKey(row), Number(row.count)]));
      return { scope, sources, indexedCounts };
    });
  }

  async function prepareSource(scope: ReferenceIndexScope, expected: ReferenceSourceVersion): Promise<PreparedReferenceSource | null> {
    const captured = await transaction(async (tx) => {
      if (!await scopeIsCurrent(tx, scope)) return null;
      const source = await readCurrentSource(tx, expected);
      if (!source || !sameReferenceSourceVersion(source, expected)) return null;
      if (source.basis.kind === 'json') return { source, contentJson: source.basis.contentJson };
      if (!source.basis.hasState) {
        // A durable revision without its state is corruption, never a request
        // to fall back to an older materialized JSON cache.
        throw new Error('Reference source has a durable Yjs revision but no Yjs state.');
      }
      if (!isProseEntityType(source.kind)) throw new Error('Invalid Yjs reference source kind.');
      const docId = proseDocId(source.kind, source.id);
      const repo = createYjsRepository(tx);
      const snapshot = await repo.getSnapshot(docId);
      const updates = await repo.listUpdates(docId);
      return { source, updates: [...(snapshot ? [snapshot.stateBlob] : []), ...updates.map((row) => row.updateBlob)] };
    });
    if (!captured) return null;
    assertCurrent();
    let json: unknown;
    if ('contentJson' in captured) {
      // Invalid JSON rejects before an index write; retain the previous rows.
      json = captured.contentJson ? JSON.parse(captured.contentJson) : undefined;
    } else {
      const doc = new Y.Doc({ gc: false });
      try {
        for (const update of captured.updates) Y.applyUpdate(doc, update, 'reference-index-read');
        if (doc.store.pendingStructs || doc.store.pendingDs) {
          throw new Error('Reference source Yjs state has unresolved update dependencies.');
        }
        json = yDocToProsemirrorJSON(doc, 'default');
      } finally {
        doc.destroy();
      }
    }
    const drafts = projectInlineMentionsFromJson(json);
    assertCurrent();
    return { scope, source: captured.source, drafts };
  }

  async function replaceSource(prepared: PreparedReferenceSource): Promise<boolean> {
    return transaction(async (tx) => {
      if (!await scopeIsCurrent(tx, prepared.scope)) return false;
      const current = await readCurrentSource(tx, prepared.source);
      if (!current || !sameReferenceSourceVersion(current, prepared.source)) return false;
      assertCurrent();
      await createInlineMentionRepository(tx).replaceMentionsFromSource(
        projectId, current.kind, current.id, [...prepared.drafts],
      );
      return true;
    }, true);
  }

  async function pruneOrphanSources(scope: ReferenceIndexScope): Promise<number | null> {
    return transaction(async (tx) => {
      if (!await scopeIsCurrent(tx, scope)) return null;
      // Re-read existence inside this write transaction: an older catalog must
      // never delete references belonging to a newly created/restored source.
      const current = new Set((await loadSourceRows(tx, projectId)).map(referenceSourceKey));
      const indexed = await tx.selectDistinct({ kind: InlineMentionTable.fromKind, id: InlineMentionTable.fromId })
        .from(InlineMentionTable).where(eq(InlineMentionTable.projectId, projectId));
      let removedSources = 0;
      for (const source of indexed) {
        // Unknown/annotative source formats are outside this five-kind index.
        if (!isStructuralEntityKind(source.kind) || current.has(referenceSourceKey(source))) continue;
        assertCurrent();
        await tx.delete(InlineMentionTable).where(and(
          eq(InlineMentionTable.projectId, projectId), eq(InlineMentionTable.fromKind, source.kind),
          eq(InlineMentionTable.fromId, source.id),
        ));
        removedSources += 1;
      }
      return removedSources;
    }, true);
  }

  return { captureCatalog, prepareSource, replaceSource, pruneOrphanSources };
}

export function referenceSourceKey(source: { kind: string; id: string }): string {
  return JSON.stringify([source.kind, source.id]);
}

function sourceVersion(row: SourceRow, revision = 0, hasState = false): ReferenceSourceVersion {
  return {
    kind: row.kind, id: row.id, createdAt: row.createdAt,
    basis: hasState || revision > 0
      ? { kind: 'yjs', revision, hasState }
      : { kind: 'json', contentJson: row.contentJson },
  };
}

async function loadSourceRows(tx: DbTransaction, projectId: string, only?: ReferenceSourceId | readonly ReferenceSourceId[]): Promise<SourceRow[]> {
  const rows: SourceRow[] = [];
  const selected: readonly ReferenceSourceId[] | undefined = only ? ('kind' in only ? [only] : only) : undefined;
  const forKind = (kind: StructuralEntityKind) => selected?.filter((id) => id.kind === kind).map((id) => id.id);
  const nodeIds = forKind('node');
  if (!nodeIds || nodeIds.length > 0) {
    const found = await tx.select({ id: BookNodeTable.id, createdAt: BookNodeTable.createdAt, contentJson: NodeContentTable.contentJson })
      .from(BookNodeTable).leftJoin(NodeContentTable, eq(BookNodeTable.id, NodeContentTable.nodeId))
      .where(and(eq(BookNodeTable.projectId, projectId), isNull(BookNodeTable.deletedAt), nodeIds ? inArray(BookNodeTable.id, nodeIds) : undefined));
    rows.push(...found.map((row) => ({ ...row, kind: 'node' as const })));
  }
  const elementIds = forKind('element');
  if (!elementIds || elementIds.length > 0) {
    const found = await tx.select({ id: BookElementTable.id, createdAt: BookElementTable.createdAt, contentJson: BookElementTable.contentJson })
      .from(BookElementTable).where(and(eq(BookElementTable.projectId, projectId), isNull(BookElementTable.deletedAt), elementIds ? inArray(BookElementTable.id, elementIds) : undefined));
    rows.push(...found.map((row) => ({ ...row, kind: 'element' as const })));
  }
  const categoryIds = forKind('category');
  if (!categoryIds || categoryIds.length > 0) {
    const found = await tx.select({ id: ElementCategoryTable.id, createdAt: ElementCategoryTable.createdAt, contentJson: ElementCategoryTable.contentJson })
      .from(ElementCategoryTable).where(and(eq(ElementCategoryTable.projectId, projectId), isNull(ElementCategoryTable.deletedAt), categoryIds ? inArray(ElementCategoryTable.id, categoryIds) : undefined));
    rows.push(...found.map((row) => ({ ...row, kind: 'category' as const })));
  }
  const storylineIds = forKind('storyline');
  if (!storylineIds || storylineIds.length > 0) {
    const found = await tx.select({ id: StorylineTable.id, createdAt: StorylineTable.createdAt, contentJson: StorylineTable.contentJson })
      .from(StorylineTable).where(and(eq(StorylineTable.projectId, projectId), isNull(StorylineTable.deletedAt), storylineIds ? inArray(StorylineTable.id, storylineIds) : undefined));
    rows.push(...found.map((row) => ({ ...row, kind: 'storyline' as const })));
  }
  const patchIds = forKind('patch');
  if (!patchIds || patchIds.length > 0) {
    // Patches have no trash marker; their parent element owns their visibility.
    const found = await tx.select({ id: ElementPatchTable.id, createdAt: ElementPatchTable.createdAt, contentJson: ElementPatchTable.contentJson })
      .from(ElementPatchTable).innerJoin(BookElementTable, and(eq(ElementPatchTable.elementId, BookElementTable.id), eq(BookElementTable.projectId, projectId), isNull(BookElementTable.deletedAt)))
      .where(and(eq(ElementPatchTable.projectId, projectId), patchIds ? inArray(ElementPatchTable.id, patchIds) : undefined));
    rows.push(...found.map((row) => ({ ...row, kind: 'patch' as const })));
  }
  return rows;
}
