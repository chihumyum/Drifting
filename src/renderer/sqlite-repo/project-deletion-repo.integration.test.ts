import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

import { ProductFileBackedSqliteGateway } from '../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import {
  AgentRuntimeResultArtifactTable,
  AgentRuntimeResultBlobTable,
  AgentRuntimeSessionTable,
  AgentRuntimeToolCallTable,
  AgentRuntimeTurnTable,
  AgentRuntimeWriteEffectTable,
  AgentRuntimeWriteReviewTable,
  BookNodeTable,
  CommentActionTable,
  CommentTable,
  EntitySnapshotHistoryTable,
  ProjectAssetTable,
  ProjectTable,
  YjsDocumentRevisionProvenanceTable,
  YjsDocumentRevisionTable,
  YjsProseCommandReceiptTable,
  yjsSnapshots,
  yjsUpdates,
} from '../schema/drizzle';
import { deleteProjectDataInTransaction } from './project-deletion-repo';

const temporaryDirectories: string[] = [];
const openGateways: ProductFileBackedSqliteGateway[] = [];
const NOW = '2026-08-14T00:00:00.000Z';
const SHARED_CONTENT_HASH = `sha256:${'0'.repeat(64)}`;

async function createDatabase() {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-project-delete-'));
  temporaryDirectories.push(directory);
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'drifting.db'));
  openGateways.push(gateway);
  return { gateway, db: gateway.client() };
}

async function seedProject(
  db: ReturnType<ProductFileBackedSqliteGateway['client']>,
  projectId: string,
  nodeId: string,
): Promise<void> {
  await db.insert(ProjectTable).values({
    id: projectId,
    name: projectId,
    userId: 'local-user',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(BookNodeTable).values({
    id: nodeId,
    title: nodeId,
    projectId,
    positionX: 0,
    positionY: 0,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function seedAgentArtifact(
  db: ReturnType<ProductFileBackedSqliteGateway['client']>,
  projectId: string,
  suffix: string,
  contentHash: string,
): Promise<void> {
  const sessionId = `session-${suffix}`;
  const turnId = `turn-${suffix}`;
  const readToolCallId = `read-tool-${suffix}`;
  const readCallId = `read-call-${suffix}`;
  const readIdempotencyKey = `read-idempotency-${suffix}`;
  const writeToolCallId = `write-tool-${suffix}`;
  const writeCallId = `write-call-${suffix}`;
  const writeIdempotencyKey = `write-idempotency-${suffix}`;

  await db.insert(AgentRuntimeSessionTable).values({
    id: sessionId,
    projectId,
    routeKind: 'goal',
    provider: 'deepseek',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(AgentRuntimeTurnTable).values({
    id: turnId,
    sessionId,
    ordinal: 0,
    acceptedAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(AgentRuntimeToolCallTable).values([
    {
      id: readToolCallId,
      sessionId,
      turnId,
      callId: readCallId,
      name: 'read_node',
      access: 'read',
      idempotencyKey: readIdempotencyKey,
      argumentsJson: '{}',
      createdAt: NOW,
    },
    {
      id: writeToolCallId,
      sessionId,
      turnId,
      callId: writeCallId,
      name: 'set_summary',
      access: 'write',
      idempotencyKey: writeIdempotencyKey,
      argumentsJson: '{}',
      createdAt: NOW,
    },
  ]);
  await db.insert(AgentRuntimeResultArtifactTable).values({
    ref: `result-${suffix}`,
    projectId,
    sessionId,
    turnId,
    toolCallId: readToolCallId,
    callId: readCallId,
    toolName: 'read_node',
    toolAccess: 'read',
    idempotencyKey: readIdempotencyKey,
    argumentsJson: '{}',
    contentHash,
    createdAt: NOW,
  });
  await db.insert(AgentRuntimeWriteEffectTable).values({
    id: `effect-${suffix}`,
    projectId,
    routeKind: 'goal',
    sessionId,
    turnId,
    toolCallId: writeToolCallId,
    callId: writeCallId,
    toolName: 'set_summary',
    toolAccess: 'write',
    idempotencyKey: writeIdempotencyKey,
    argumentsJson: '{}',
    claimedAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(AgentRuntimeWriteReviewTable).values({
    id: `review-${suffix}`,
    effectId: `effect-${suffix}`,
    sessionId,
    turnId,
    toolCallId: writeToolCallId,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function seedYjsState(
  db: ReturnType<ProductFileBackedSqliteGateway['client']>,
  docId: string,
): Promise<void> {
  const bytes = new Uint8Array([1, 2, 3]);
  await db.insert(yjsUpdates).values({ docId, updateBlob: bytes, createdAt: NOW });
  await db.insert(yjsSnapshots).values({ docId, stateBlob: bytes, updatedAt: NOW });
  await db.insert(YjsDocumentRevisionTable).values({ docId, revision: 1, updatedAt: NOW });
  await db.insert(YjsDocumentRevisionProvenanceTable).values({
    docId,
    revision: 1,
    sourceKind: 'live',
    createdAt: NOW,
  });
  await db.insert(YjsProseCommandReceiptTable).values({
    id: `receipt:${docId}`,
    commandId: `command:${docId}`,
    direction: 'forward',
    docId,
    sourceKind: 'live',
    baseRevision: 0,
    committedRevision: 1,
    baseStateVector: bytes,
    baseStateHash: 'base',
    resultStateVector: bytes,
    resultStateHash: 'result',
    updateHash: 'update',
    updateId: 1,
    createdAt: NOW,
  });
}

afterEach(async () => {
  for (const gateway of openGateways.splice(0)) await gateway.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('transactional project deletion', () => {
  it('uses the current comment FK and purges project-owned SQLite state', async () => {
    const { gateway, db } = await createDatabase();
    const foreignKey = gateway.database
      .prepare("PRAGMA foreign_key_list('comment_action')")
      .all() as Array<{ table: string; from: string }>;
    expect(foreignKey).toEqual(
      expect.arrayContaining([expect.objectContaining({ table: 'comment', from: 'comment_id' })]),
    );
    expect(gateway.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    await seedProject(db, 'project-a', 'node-a');
    await seedProject(db, 'project-b', 'node-b');
    const docA = 'node-content:node-a';
    const historicalDocA = 'node-content:deleted-node-a';
    const docB = 'node-content:node-b';
    await seedYjsState(db, docA);
    await seedYjsState(db, historicalDocA);
    await seedYjsState(db, docB);

    await db.insert(EntitySnapshotHistoryTable).values([
      {
        id: 'history-a',
        projectId: 'project-a',
        entityKind: 'node',
        entityId: 'deleted-node-a',
        stateBlob: new Uint8Array([1]),
        createdAt: NOW,
      },
      {
        id: 'history-b',
        projectId: 'project-b',
        entityKind: 'node',
        entityId: 'node-b',
        stateBlob: new Uint8Array([2]),
        createdAt: NOW,
      },
    ]);
    await db.insert(ProjectAssetTable).values({
      id: 'soft-deleted-asset-a',
      projectId: 'project-a',
      kind: 'image',
      sourceMime: 'image/png',
      sourceSizeBytes: 1,
      sourceSha256: '0'.repeat(64),
      width: 1,
      height: 1,
      createdAt: NOW,
    });
    await db.insert(CommentTable).values({
      id: 'comment-a',
      projectId: 'project-a',
      kind: 'todo',
      bodyJson: '{}',
      createdAt: NOW,
      updatedAt: NOW,
    });
    await db.insert(CommentActionTable).values({
      id: 'action-a',
      projectId: 'project-a',
      commentId: 'comment-a',
      kind: 'apply',
      createdAt: NOW,
      updatedAt: NOW,
    });

    await db.insert(AgentRuntimeResultBlobTable).values({
      contentHash: SHARED_CONTENT_HASH,
      contentBlob: new Uint8Array([9]),
      byteCount: 1,
      charCount: 1,
      createdAt: NOW,
    });
    await seedAgentArtifact(db, 'project-a', 'a', SHARED_CONTENT_HASH);
    await seedAgentArtifact(db, 'project-b', 'b', SHARED_CONTENT_HASH);

    const receipt = await db.transaction((tx) =>
      deleteProjectDataInTransaction(tx, 'project-a'),
    );
    expect(receipt?.proseDocIds).toEqual(expect.arrayContaining([docA, historicalDocA]));
    expect(receipt?.agentReviewIds).toEqual(['review-a']);
    expect(receipt?.assetIds).toEqual(['soft-deleted-asset-a']);

    expect(await db.select().from(ProjectTable).where(eq(ProjectTable.id, 'project-a'))).toEqual(
      [],
    );
    expect(await db.select().from(CommentActionTable)).toEqual([]);
    for (const table of [
      yjsUpdates,
      yjsSnapshots,
      YjsDocumentRevisionTable,
      YjsDocumentRevisionProvenanceTable,
      YjsProseCommandReceiptTable,
    ] as const) {
      expect(
        await db
          .select()
          .from(table)
          .where(inArray(table.docId, [docA, historicalDocA])),
      ).toEqual([]);
    }
    expect(
      await db
        .select()
        .from(EntitySnapshotHistoryTable)
        .where(eq(EntitySnapshotHistoryTable.projectId, 'project-a')),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(AgentRuntimeResultArtifactTable)
        .where(eq(AgentRuntimeResultArtifactTable.projectId, 'project-a')),
    ).toEqual([]);
    expect(await db.select().from(AgentRuntimeResultBlobTable)).toHaveLength(1);
    expect(await db.select().from(AgentRuntimeWriteReviewTable)).toEqual([
      expect.objectContaining({ id: 'review-b' }),
    ]);
    expect(await db.select().from(yjsSnapshots).where(eq(yjsSnapshots.docId, docB))).toHaveLength(1);
    expect(gateway.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    await db.transaction((tx) => deleteProjectDataInTransaction(tx, 'project-b'));
    expect(await db.select().from(AgentRuntimeResultBlobTable)).toEqual([]);
    expect(gateway.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('rolls back prose/history/project deletion as one transaction', async () => {
    const { db } = await createDatabase();
    await seedProject(db, 'project-rollback', 'node-rollback');
    const docId = 'node-content:node-rollback';
    await seedYjsState(db, docId);
    await db.insert(EntitySnapshotHistoryTable).values({
      id: 'history-rollback',
      projectId: 'project-rollback',
      entityKind: 'node',
      entityId: 'node-rollback',
      stateBlob: new Uint8Array([1]),
      createdAt: NOW,
    });

    await expect(
      db.transaction(async (tx) => {
        await deleteProjectDataInTransaction(tx, 'project-rollback');
        throw new Error('injected rollback');
      }),
    ).rejects.toThrow('injected rollback');

    expect(
      await db.select().from(ProjectTable).where(eq(ProjectTable.id, 'project-rollback')),
    ).toHaveLength(1);
    expect(await db.select().from(yjsSnapshots).where(eq(yjsSnapshots.docId, docId))).toHaveLength(
      1,
    );
    expect(
      await db
        .select()
        .from(EntitySnapshotHistoryTable)
        .where(eq(EntitySnapshotHistoryTable.projectId, 'project-rollback')),
    ).toHaveLength(1);
  });
});
