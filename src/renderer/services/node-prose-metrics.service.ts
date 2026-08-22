import { deriveProseMetric } from '@drifting/prose-metrics';
import { and, eq, isNull } from 'drizzle-orm';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import * as Y from 'yjs';

import { hasCanonicalWordCount, type BookNode, type WordCountBasisKind } from '../domain/book-node';
import { extractOutline, serializeOutline } from '../lib/outline';
import { proseDocId } from '../lib/yjs-doc-id';
import { createEntitySeedUpdate } from '../hooks/useEntityYjsDoc';
import { BookNodeTable, NodeContentTable } from '../schema/drizzle';
import { createBookContentRepository } from '../sqlite-repo/content-repo';
import { createBookNodeSqliteRepository } from '../sqlite-repo/node-repo';
import { createYjsRepository } from '../sqlite-repo/yjs-repo';
import { useDataStore } from '../store/data-store';
import { useProseMetricsStatusStore } from '../store/prose-metrics-status-store';
import type { DbExecutor } from '../lib/db';
import {
  createYjsProsePersistenceCoordinator,
  type YjsProsePersistenceBase,
} from '../lib/agent/runtime/yjs-prose-persistence-coordinator';
import { runDerivedTransaction } from '../sync/journal';

const EMPTY_DOCUMENT = JSON.stringify({ type: 'doc', content: [] });
const MAX_RECONCILE_CONCURRENCY = 4;
const inFlightByOperation = new Map<string, Promise<void>>();

export class NodeProseMetricRevisionConflictError extends Error {
  readonly code = 'STALE_PROSE_METRIC_REVISION';

  constructor(
    readonly nodeId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Node ${nodeId} prose metric expected Yjs revision ${expectedRevision}, received ${actualRevision}.`,
    );
    this.name = 'NodeProseMetricRevisionConflictError';
  }
}

export interface CanonicalNodeProseProjection {
  nodeId: string;
  contentJson: string;
  outlineJson: string;
  wordCount: number;
  wordCountBasisKind: WordCountBasisKind;
  wordCountBasisHash: string;
  wordCountBasisRevision: number | null;
  wordCountBasisServerSeq: number | null;
}

export interface PersistNodeProseProjectionInput extends CanonicalNodeProseProjection {
  projectId: string;
  updatedAt: string;
  touchNodeUpdatedAt?: boolean;
  publishToDataStore?: boolean;
}

export interface ReconcileProjectProseMetricsOptions {
  /**
   * Project workspaces own the live renderer store. Shelf reconciliation must
   * stay SQLite-only so scanning another project cannot leak its nodes into the
   * currently mounted workspace.
   */
  publishToDataStore?: boolean;
}

export function canReuseCanonicalProjection(
  node: BookNode,
  content: { contentJson: string; outlineJson: string } | null,
  projection: CanonicalNodeProseProjection,
): boolean {
  const existingBasisIsExact =
    hasCanonicalWordCount(node) &&
    node.wordCountBasisHash === projection.wordCountBasisHash &&
    node.wordCount === projection.wordCount;
  const basisMatchesCapture =
    node.wordCountBasisKind === 'seed'
      ? projection.wordCountBasisKind === 'seed'
      : node.wordCountBasisServerSeq != null ||
        (projection.wordCountBasisKind === 'yjs' &&
          node.wordCountBasisRevision === projection.wordCountBasisRevision);
  return (
    existingBasisIsExact &&
    basisMatchesCapture &&
    content?.contentJson === projection.contentJson &&
    content.outlineJson === projection.outlineJson
  );
}

export async function deriveCanonicalNodeProseProjection(
  nodeId: string,
  base: YjsProsePersistenceBase,
): Promise<CanonicalNodeProseProjection> {
  const doc = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(doc, base.stateUpdate, 'prose-metric');
    const document = yDocToProsemirrorJSON(doc, 'default');
    const contentJson = JSON.stringify(document);
    const metric = await deriveProseMetric(document);
    return {
      nodeId,
      contentJson,
      outlineJson: serializeOutline(extractOutline(contentJson)),
      wordCount: metric.wordCount,
      wordCountBasisKind: base.sourceKind === 'seed' ? 'seed' : 'yjs',
      wordCountBasisHash: metric.basisHash,
      wordCountBasisRevision: base.sourceKind === 'seed' ? null : base.revision,
      wordCountBasisServerSeq: null,
    };
  } finally {
    doc.destroy();
  }
}

export async function persistNodeProseProjectionInTransaction(
  tx: DbExecutor,
  input: PersistNodeProseProjectionInput,
): Promise<{ node: BookNode; contentJson: string; outlineJson: string }> {
  const docId = proseDocId('node', input.nodeId);
  const expectedRevision = input.wordCountBasisKind === 'seed' ? 0 : input.wordCountBasisRevision;
  if (expectedRevision != null) {
    const actualRevision = await createYjsRepository(tx).getRevision(docId);
    if (actualRevision !== expectedRevision) {
      throw new NodeProseMetricRevisionConflictError(
        input.nodeId,
        expectedRevision,
        actualRevision,
      );
    }
  }

  const contentRepo = createBookContentRepository(tx, input.projectId);
  const existingContent = await contentRepo.findByNodeId(input.nodeId);
  let content;
  if (existingContent && input.touchNodeUpdatedAt === false) {
    await tx
      .update(NodeContentTable)
      .set({ contentJson: input.contentJson, outlineJson: input.outlineJson })
      .where(eq(NodeContentTable.nodeId, input.nodeId));
    content = {
      ...existingContent,
      contentJson: input.contentJson,
      outlineJson: input.outlineJson,
    };
  } else {
    content = existingContent
      ? await contentRepo.updateByNodeId(input.nodeId, {
          contentJson: input.contentJson,
          outlineJson: input.outlineJson,
          updatedAt: input.updatedAt,
        })
      : await contentRepo.create({
          nodeId: input.nodeId,
          contentJson: input.contentJson,
          outlineJson: input.outlineJson,
        });
  }
  if (!content) throw new Error(`Node content ${input.nodeId} could not be materialized.`);

  const rows = await tx
    .update(BookNodeTable)
    .set({
      wordCount: input.wordCount,
      wordCountBasisKind: input.wordCountBasisKind,
      wordCountBasisHash: input.wordCountBasisHash,
      wordCountBasisRevision: input.wordCountBasisRevision,
      wordCountBasisServerSeq: input.wordCountBasisServerSeq,
      ...(input.touchNodeUpdatedAt === false ? {} : { updatedAt: input.updatedAt }),
    })
    .where(
      and(
        eq(BookNodeTable.id, input.nodeId),
        eq(BookNodeTable.projectId, input.projectId),
        isNull(BookNodeTable.deletedAt),
      ),
    )
    .returning();
  if (!rows[0]) throw new Error(`Node ${input.nodeId} no longer exists.`);
  const node = await createBookNodeSqliteRepository(input.projectId, tx).findById(input.nodeId);
  if (!node) throw new Error(`Node ${input.nodeId} could not be reloaded.`);
  return { node, contentJson: content.contentJson, outlineJson: content.outlineJson };
}

async function persistProjection(
  input: PersistNodeProseProjectionInput,
): Promise<CanonicalNodeProseProjection> {
  const result = await runDerivedTransaction(
    'prose.node-metrics-projection',
    (tx) => persistNodeProseProjectionInTransaction(tx, input),
  );
  if (input.publishToDataStore !== false) {
    const workspace = useDataStore.getState();
    if (workspace.workspaceProjectId === input.projectId) {
      workspace.updateBookNode(input.nodeId, result.node);
    }
  }
  return {
    ...input,
    contentJson: result.contentJson,
    outlineJson: result.outlineJson,
  };
}

async function captureNodeProjection(
  projectId: string,
  nodeId: string,
  fallbackContentJson?: string | null,
): Promise<CanonicalNodeProseProjection> {
  const contentJson =
    fallbackContentJson ??
    (await createBookContentRepository(undefined, projectId).findByNodeId(nodeId))?.contentJson ??
    EMPTY_DOCUMENT;
  const seedUpdate = await createEntitySeedUpdate(contentJson);
  const base = await createYjsProsePersistenceCoordinator().readBase(
    proseDocId('node', nodeId),
    seedUpdate,
  );
  return deriveCanonicalNodeProseProjection(nodeId, base);
}

export async function materializeCanonicalNodeProse(
  projectId: string,
  nodeId: string,
  fallbackContentJson?: string | null,
  options: { touchNodeUpdatedAt?: boolean; publishToDataStore?: boolean } = {},
): Promise<CanonicalNodeProseProjection> {
  let lastConflict: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const projection = await captureNodeProjection(projectId, nodeId, fallbackContentJson);
    try {
      const [node, content] = await Promise.all([
        createBookNodeSqliteRepository(projectId).findById(nodeId),
        createBookContentRepository(undefined, projectId).findByNodeId(nodeId),
      ]);
      if (node && canReuseCanonicalProjection(node, content, projection)) {
        return {
          ...projection,
          wordCountBasisKind: node.wordCountBasisKind!,
          wordCountBasisRevision: node.wordCountBasisRevision ?? null,
          wordCountBasisServerSeq: node.wordCountBasisServerSeq ?? null,
        };
      }
      return await persistProjection({
        projectId,
        ...projection,
        updatedAt: new Date().toISOString(),
        touchNodeUpdatedAt: options.touchNodeUpdatedAt,
        publishToDataStore: options.publishToDataStore,
      });
    } catch (error) {
      if (!(error instanceof NodeProseMetricRevisionConflictError)) throw error;
      lastConflict = error;
    }
  }
  throw lastConflict ?? new Error(`Node ${nodeId} prose metric could not stabilize.`);
}

async function reconcileProject(
  projectId: string,
  options: ReconcileProjectProseMetricsOptions,
): Promise<void> {
  const status = useProseMetricsStatusStore.getState();
  status.setStatus(projectId, 'reconciling');
  const nodes = await createBookNodeSqliteRepository(projectId).findAll();
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(MAX_RECONCILE_CONCURRENCY, Math.max(1, nodes.length)) },
    async () => {
      while (cursor < nodes.length) {
        const node = nodes[cursor++];
        try {
          await materializeCanonicalNodeProse(projectId, node.id, undefined, {
            touchNodeUpdatedAt: false,
            publishToDataStore: options.publishToDataStore,
          });
        } catch (error) {
          // A concurrent user delete is not a reconciliation failure: the row
          // left the active project while this bounded scan was in flight.
          if (!(await createBookNodeSqliteRepository(projectId).findById(node.id))) continue;
          throw error;
        }
      }
    },
  );
  await Promise.all(workers);
  useProseMetricsStatusStore.getState().setStatus(projectId, 'ready');
}

export function reconcileProjectProseMetrics(
  projectId: string,
  options: ReconcileProjectProseMetricsOptions = {},
): Promise<void> {
  const operationKey = `${projectId}:${options.publishToDataStore === false ? 'sqlite' : 'workspace'}`;
  const existing = inFlightByOperation.get(operationKey);
  if (existing) return existing;
  const operation = reconcileProject(projectId, options)
    .catch((error) => {
      useProseMetricsStatusStore
        .getState()
        .setStatus(projectId, 'error', error instanceof Error ? error.message : String(error));
      throw error;
    })
    .finally(() => {
      if (inFlightByOperation.get(operationKey) === operation) {
        inFlightByOperation.delete(operationKey);
      }
    });
  inFlightByOperation.set(operationKey, operation);
  return operation;
}
