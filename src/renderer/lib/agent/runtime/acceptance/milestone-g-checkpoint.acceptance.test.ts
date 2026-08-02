import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentUserCheckpointRepository } from '../../../../sqlite-repo/agent-user-checkpoint-repo';
import { createAgentUserCheckpointRepository } from '../../../../sqlite-repo/agent-user-checkpoint-repo';
import { createYjsRepository, type YjsRepository } from '../../../../sqlite-repo/yjs-repo';
import { canonicalAgentRuntimeJson } from '../../../../sqlite-repo/agent-runtime-persistence-repo';
import { createAgentUserCheckpointService } from '../../../../services/agent-user-checkpoint.service';
import type {
  AgentCheckpointWorkspaceEntityState,
  AgentUserCheckpointWorkspace,
} from '../../../../services/agent-user-checkpoint-workspace';
import {
  replaceYjsProseBlocks,
  snapshotYjsProseBlocks,
  type YjsProseNode,
} from '../yjs-prose-command';
import { proseDocId } from '../../../yjs-doc-id';
import { ProductFileBackedSqliteGateway } from './p3-file-backed-sqlite';

const PROJECT_ID = 'project-checkpoint';
const CONVERSATION_ID = 'conversation-checkpoint';
const NOW = '2026-08-02T12:00:00.000Z';
const directories = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...directories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  directories.clear();
});

async function sha256(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return `sha256:${Buffer.from(digest).toString('hex')}`;
}

class FileBackedYjsWorkspace implements AgentUserCheckpointWorkspace {
  private yjs: YjsRepository;
  failNextRestoreFor: string | null = null;

  constructor(readonly gateway: ProductFileBackedSqliteGateway) {
    this.yjs = createYjsRepository(gateway.client());
  }

  async createNode(id: string, title: string, text: string): Promise<void> {
    this.gateway.database
      .prepare(
        `INSERT INTO book_node (
           id, title, summary, book_order, project_id, kind, writing_status,
           created_at, updated_at, position_x, position_y
         ) VALUES (?, ?, '', ?, ?, 'chapter', 'draft', ?, ?, 0, 0)`,
      )
      .run(id, title, id === 'chapter-a' ? 0 : 1, PROJECT_ID, NOW, NOW);
    this.gateway.database
      .prepare(
        `INSERT INTO node_content (
           node_id, content_json, outline_json, plot_grid_json, created_at, updated_at
         ) VALUES (?, '{}', '[]', '{}', ?, ?)`,
      )
      .run(id, NOW, NOW);
    const doc = new Y.Doc({ gc: false });
    try {
      replaceYjsProseBlocks(doc, [
        { id: `${id}-p`, type: 'paragraph', attrs: {}, content: [{ kind: 'text', text }] },
      ]);
      await this.yjs.upsertSnapshot(proseDocId('node', id), Y.encodeStateAsUpdate(doc));
    } finally {
      doc.destroy();
    }
  }

  async listProjectEntityStates(projectId: string): Promise<AgentCheckpointWorkspaceEntityState[]> {
    const rows = this.gateway.database
      .prepare(
        `SELECT id FROM book_node
         WHERE project_id = ? AND deleted_at IS NULL
         ORDER BY book_order, id`,
      )
      .all(projectId) as { id: string }[];
    const states = await Promise.all(rows.map((row) => this.readEntityState(projectId, 'node', row.id)));
    return states.filter((state): state is AgentCheckpointWorkspaceEntityState => Boolean(state));
  }

  async readEntityState(
    projectId: string,
    entityKind: 'node' | 'element' | 'storyline' | 'category',
    entityId: string,
  ): Promise<AgentCheckpointWorkspaceEntityState | null> {
    if (entityKind !== 'node') return null;
    const row = this.gateway.database
      .prepare(
        `SELECT id, title, summary, writing_status AS writingStatus
         FROM book_node WHERE project_id = ? AND id = ? AND deleted_at IS NULL`,
      )
      .get(projectId, entityId) as
      | { id: string; title: string; summary: string; writingStatus: string }
      | undefined;
    if (!row) return null;
    const documentId = proseDocId('node', entityId);
    const doc = await this.loadDoc(documentId);
    try {
      const stateBlob = Y.encodeStateAsUpdate(doc);
      const stateVector = Y.encodeStateVector(doc);
      const contentJson = canonicalAgentRuntimeJson(snapshotYjsProseBlocks(doc));
      const metadataJson = canonicalAgentRuntimeJson({
        title: row.title,
        summary: row.summary,
        writingStatus: row.writingStatus,
      });
      return {
        projectId,
        entityKind: 'node',
        entityId,
        displayName: row.title,
        documentId,
        yjsRevision: await this.yjs.getRevision(documentId),
        stateVector,
        stateHash: await sha256(stateBlob),
        contentHash: await sha256(contentJson),
        stateBlob,
        metadataJson,
        metadataHash: await sha256(metadataJson),
      };
    } finally {
      doc.destroy();
    }
  }

  async restoreEntityState(target: AgentCheckpointWorkspaceEntityState): Promise<void> {
    if (this.failNextRestoreFor === target.entityId) {
      this.failNextRestoreFor = null;
      throw new Error(`injected restore failure for ${target.entityId}`);
    }
    const current = await this.loadDoc(target.documentId);
    const source = new Y.Doc({ gc: false });
    try {
      Y.applyUpdate(source, target.stateBlob, 'checkpoint-source');
      const updates: Uint8Array[] = [];
      current.on('update', (update, origin) => {
        if (origin === 'checkpoint-cover') updates.push(new Uint8Array(update));
      });
      current.transact(
        () => replaceYjsProseBlocks(current, snapshotYjsProseBlocks(source)),
        'checkpoint-cover',
      );
      const revision = await this.yjs.getRevision(target.documentId);
      for (const update of updates) {
        await this.yjs.appendUpdateCas(target.documentId, update, revision);
      }
      await this.yjs.upsertSnapshot(
        target.documentId,
        Y.encodeStateAsUpdate(current),
        { advanceRevision: false },
      );
      const metadata = JSON.parse(target.metadataJson) as {
        title: string;
        summary: string;
        writingStatus: string;
      };
      this.gateway.database
        .prepare(
          `UPDATE book_node
           SET title = ?, summary = ?, writing_status = ?, updated_at = ?
           WHERE project_id = ? AND id = ?`,
        )
        .run(
          metadata.title,
          metadata.summary,
          metadata.writingStatus,
          new Date().toISOString(),
          target.projectId,
          target.entityId,
        );
    } finally {
      source.destroy();
      current.destroy();
    }
  }

  async authorEdit(entityId: string, text: string, title?: string): Promise<void> {
    const documentId = proseDocId('node', entityId);
    const doc = await this.loadDoc(documentId);
    try {
      const updates: Uint8Array[] = [];
      doc.on('update', (update, origin) => {
        if (origin === 'author') updates.push(new Uint8Array(update));
      });
      doc.transact(
        () =>
          replaceYjsProseBlocks(doc, [
            {
              id: `${entityId}-p`,
              type: 'paragraph',
              attrs: {},
              content: [{ kind: 'text', text }],
            },
          ]),
        'author',
      );
      let revision = await this.yjs.getRevision(documentId);
      for (const update of updates) {
        const result = await this.yjs.appendUpdateCas(documentId, update, revision);
        revision = result.revision;
      }
      await this.yjs.upsertSnapshot(documentId, Y.encodeStateAsUpdate(doc), {
        advanceRevision: false,
      });
      if (title) {
        this.gateway.database
          .prepare('UPDATE book_node SET title = ?, updated_at = ? WHERE id = ?')
          .run(title, new Date().toISOString(), entityId);
      }
    } finally {
      doc.destroy();
    }
  }

  async text(entityId: string): Promise<string> {
    const doc = await this.loadDoc(proseDocId('node', entityId));
    try {
      const readNode = (node: YjsProseNode): string =>
        node.kind === 'text'
          ? node.text
          : (node.content ?? []).map(readNode).join('');
      return snapshotYjsProseBlocks(doc)
        .flatMap((block) => block.content ?? [])
        .map(readNode)
        .join('');
    } finally {
      doc.destroy();
    }
  }

  private async loadDoc(documentId: string): Promise<Y.Doc> {
    const doc = new Y.Doc({ gc: false });
    const snapshot = await this.yjs.getSnapshot(documentId);
    if (snapshot) Y.applyUpdate(doc, snapshot.stateBlob, 'load');
    for (const update of await this.yjs.listUpdates(documentId)) {
      Y.applyUpdate(doc, update.updateBlob, 'load');
    }
    return doc;
  }
}

interface Fixture {
  directory: string;
  databasePath: string;
  gateway: ProductFileBackedSqliteGateway;
  repository: AgentUserCheckpointRepository;
  workspace: FileBackedYjsWorkspace;
  service: ReturnType<typeof createAgentUserCheckpointService>;
  advance(ms?: number): void;
}

async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-checkpoint-'));
  directories.add(directory);
  const databasePath = path.join(directory, 'drifting.db');
  const gateway = new ProductFileBackedSqliteGateway(databasePath);
  gateway.database
    .prepare(
      `INSERT INTO project (id, name, user_id, created_at, updated_at)
       VALUES (?, 'Checkpoint novel', 'user-1', ?, ?)`,
    )
    .run(PROJECT_ID, NOW, NOW);
  gateway.database
    .prepare(
      `INSERT INTO agent_conversation (
         id, project_id, title, mode, messages_json, created_at, updated_at
       ) VALUES (?, ?, 'Polish novel', 'byok', '[]', ?, ?)`,
    )
    .run(CONVERSATION_ID, PROJECT_ID, NOW, NOW);
  const repository = createAgentUserCheckpointRepository(gateway.client());
  const workspace = new FileBackedYjsWorkspace(gateway);
  await workspace.createNode('chapter-a', '第一章', '初稿 A');
  await workspace.createNode('chapter-b', '第二章', '初稿 B');
  let time = Date.parse(NOW);
  let id = 0;
  const service = createAgentUserCheckpointService({
    repository,
    workspace,
    now: () => new Date(time),
    createId: () => `checkpoint-id-${++id}`,
    captureRuntime: async () => ({
      providerHistory: [
        { role: 'user', content: '润色整本小说' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: '我会保留人物语气并逐章处理。' }],
        },
      ],
      canonicalThroughTurnOrdinal: 0,
      canonicalContextHash: 'sha256:canonical-context',
      longTaskState: { task: { objective: '润色整本小说', status: 'active' } },
      acceptedWriteEffectIds: ['effect-accepted-1'],
    }),
  });
  return {
    directory,
    databasePath,
    gateway,
    repository,
    workspace,
    service,
    advance(ms = 1_000) {
      time += ms;
    },
  };
}

async function captureInitial(f: Fixture) {
  return f.service.capture({
    projectId: PROJECT_ID,
    conversationId: CONVERSATION_ID,
    runtimeSessionId: 'session-checkpoint',
    sourceTurnId: 'turn-before-polish',
    label: '润色整本小说',
    kind: 'automatic',
    conversationMessages: [{ kind: 'user', text: '润色整本小说' }],
  });
}

describe('Milestone G — durable checkpoint, rewind and fork acceptance', () => {
  it('captures complete SQLite/Yjs state and creates an idempotent non-destructive fork', async () => {
    const f = await fixture();
    const checkpoint = await captureInitial(f);
    expect(checkpoint.entityCount).toBe(2);
    expect(checkpoint.providerHistory).toHaveLength(2);
    expect(checkpoint.longTaskState).toMatchObject({ task: { status: 'active' } });
    expect(checkpoint.acceptedWriteEffectIds).toEqual(['effect-accepted-1']);

    const preview = await f.service.preview({
      checkpointId: checkpoint.id,
      projectId: PROJECT_ID,
      kind: 'conversation_fork',
      idempotencyKey: 'fork-once',
    });
    expect(preview.entities).toEqual([]);
    const first = await f.service.forkConversation({
      actionId: preview.actionId,
      previewToken: preview.previewToken,
      mode: 'byok',
    });
    const second = await f.service.forkConversation({
      actionId: preview.actionId,
      previewToken: preview.previewToken,
      mode: 'byok',
    });
    expect(first.conversationId).toBeTruthy();
    expect(second).toMatchObject({ conversationId: first.conversationId, replayed: true });
    const fork = f.gateway.database
      .prepare(
        'SELECT fork_checkpoint_id AS checkpointId, parent_conversation_id AS parentId FROM agent_conversation WHERE id = ?',
      )
      .get(first.conversationId!) as { checkpointId: string; parentId: string };
    expect(fork).toEqual({ checkpointId: checkpoint.id, parentId: CONVERSATION_ID });
    expect(await f.workspace.text('chapter-a')).toBe('初稿 A');
  });

  it('refuses missing confirmation and a stale preview before any manuscript write', async () => {
    const f = await fixture();
    const checkpoint = await captureInitial(f);
    await f.workspace.authorEdit('chapter-a', '作者后续版本 A2');
    f.advance();
    const preview = await f.service.preview({
      checkpointId: checkpoint.id,
      projectId: PROJECT_ID,
      kind: 'restore_and_fork',
      idempotencyKey: 'restore-preview-stale',
    });
    expect(preview.changedEntityCount).toBe(1);
    await expect(
      f.service.restore({
        actionId: preview.actionId,
        previewToken: preview.previewToken,
        overwriteConfirmed: false,
      }),
    ).rejects.toMatchObject({
      code: 'CHECKPOINT_OVERWRITE_CONFIRMATION_REQUIRED',
    });
    await f.workspace.authorEdit('chapter-b', '预览之后的新编辑 B2');
    await expect(
      f.service.restore({
        actionId: preview.actionId,
        previewToken: preview.previewToken,
        overwriteConfirmed: true,
      }),
    ).rejects.toMatchObject({
      code: 'CHECKPOINT_PREVIEW_STALE',
    });
    expect(await f.workspace.text('chapter-a')).toBe('作者后续版本 A2');
    expect(await f.workspace.text('chapter-b')).toBe('预览之后的新编辑 B2');
  });

  it('restores a whole-book intent by semantic content and forks while preserving its source chat', async () => {
    const f = await fixture();
    const checkpoint = await captureInitial(f);
    await f.workspace.authorEdit('chapter-a', '待放弃 A2', '第一章（改）');
    await f.workspace.authorEdit('chapter-b', '待放弃 B2');
    f.advance();
    const preview = await f.service.preview({
      checkpointId: checkpoint.id,
      projectId: PROJECT_ID,
      kind: 'restore_and_fork',
      idempotencyKey: 'restore-success',
    });
    expect(preview.changedEntityCount).toBe(2);
    const restored = await f.service.restore({
      actionId: preview.actionId,
      previewToken: preview.previewToken,
      overwriteConfirmed: true,
      mode: 'byok',
    });
    expect(restored).toMatchObject({ restoredEntityCount: 2, replayed: false });
    expect(restored.conversationId).toBeTruthy();
    expect(await f.workspace.text('chapter-a')).toBe('初稿 A');
    expect(await f.workspace.text('chapter-b')).toBe('初稿 B');
    const title = f.gateway.database
      .prepare('SELECT title FROM book_node WHERE id = ?')
      .get('chapter-a') as { title: string };
    expect(title.title).toBe('第一章');
    const source = f.gateway.database
      .prepare('SELECT deleted_at AS deletedAt FROM agent_conversation WHERE id = ?')
      .get(CONVERSATION_ID) as { deletedAt: string | null };
    expect(source.deletedAt).toBeNull();
  });

  it('compensates all already-applied entities when a later entity fails', async () => {
    const f = await fixture();
    const checkpoint = await captureInitial(f);
    await f.workspace.authorEdit('chapter-a', '作者当前 A3');
    await f.workspace.authorEdit('chapter-b', '作者当前 B3');
    const preview = await f.service.preview({
      checkpointId: checkpoint.id,
      projectId: PROJECT_ID,
      kind: 'manuscript_restore',
      idempotencyKey: 'restore-fault',
    });
    f.workspace.failNextRestoreFor = 'chapter-b';
    await expect(
      f.service.restore({
        actionId: preview.actionId,
        previewToken: preview.previewToken,
        overwriteConfirmed: true,
      }),
    ).rejects.toMatchObject({
      code: 'CHECKPOINT_RESTORE_FAILED',
    });
    expect(await f.workspace.text('chapter-a')).toBe('作者当前 A3');
    expect(await f.workspace.text('chapter-b')).toBe('作者当前 B3');
    expect(await f.repository.getAction(preview.actionId)).toMatchObject({
      status: 'compensated',
    });
  });

  it('recovers an interrupted applying saga after a real SQLite reopen without overwriting later edits', async () => {
    const f = await fixture();
    const checkpoint = await captureInitial(f);
    await f.workspace.authorEdit('chapter-a', '崩溃前作者版本 A4');
    await f.workspace.authorEdit('chapter-b', '崩溃前作者版本 B4');
    const preview = await f.service.preview({
      checkpointId: checkpoint.id,
      projectId: PROJECT_ID,
      kind: 'manuscript_restore',
      idempotencyKey: 'restore-crash',
    });
    const actionRows = await f.repository.listActionEntities(preview.actionId);
    const first = actionRows[0]!;
    const before = await f.workspace.readEntityState(PROJECT_ID, first.entityKind, first.entityId);
    const target = (await f.repository.listCheckpointEntities(checkpoint.id))[0]!;
    expect(before).not.toBeNull();
    await f.repository.transitionAction({
      id: preview.actionId,
      from: 'previewed',
      to: 'applying',
      now: NOW,
      overwriteConfirmed: true,
    });
    await f.repository.recordActionEntityBefore({
      actionId: preview.actionId,
      entityKind: first.entityKind,
      entityId: first.entityId,
      beforeRevision: before!.yjsRevision,
      beforeStateVector: before!.stateVector,
      beforeStateBlob: before!.stateBlob,
      beforeContentHash: before!.contentHash,
      beforeMetadataJson: before!.metadataJson,
      now: NOW,
    });
    await f.workspace.restoreEntityState({ ...before!, ...target });
    await f.repository.settleActionEntity({
      actionId: preview.actionId,
      entityKind: first.entityKind,
      entityId: first.entityId,
      status: 'applied',
      now: NOW,
    });
    await f.gateway.close();

    const reopened = new ProductFileBackedSqliteGateway(f.databasePath, false);
    const repository = createAgentUserCheckpointRepository(reopened.client());
    const workspace = new FileBackedYjsWorkspace(reopened);
    const recovered = createAgentUserCheckpointService({
      repository,
      workspace,
      now: () => new Date(Date.parse(NOW) + 5_000),
      createId: () => 'unused-id',
      captureRuntime: async () => ({
        providerHistory: [],
        canonicalThroughTurnOrdinal: -1,
        canonicalContextHash: null,
        longTaskState: null,
        acceptedWriteEffectIds: [],
      }),
    });
    await recovered.recoverIncomplete(PROJECT_ID);
    expect(await workspace.text('chapter-a')).toBe('崩溃前作者版本 A4');
    expect(await workspace.text('chapter-b')).toBe('崩溃前作者版本 B4');
    expect(await repository.getAction(preview.actionId)).toMatchObject({ status: 'compensated' });
    await reopened.close();
  });
});
