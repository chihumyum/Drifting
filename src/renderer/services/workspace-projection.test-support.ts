import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProductFileBackedSqliteGateway } from '../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import { installHeadlessDatabaseClient } from '../lib/db';
import * as schema from '../schema/drizzle';
import { captureWorkspaceProjection } from './workspace-projection.service';

export const WORKSPACE_TEST_INPUT = { projectId: 'synthetic-workspace', userId: 'synthetic-user' };
export const WORKSPACE_TEST_NOW = '2026-09-12T00:00:00.000Z';
export const WORKSPACE_TEST_BODY = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Synthetic body.' }] }] });

/** All fixtures are synthetic; no application database is opened or copied. */
export async function createWorkspaceProjectionFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-workspace-projection-'));
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'synthetic.db'));
  const db = gateway.client();
  const uninstall = installHeadlessDatabaseClient(db, 'synthetic-workspace.db');
  let closed = false;
  const close = async () => { if (closed) return; closed = true; uninstall(); await gateway.close(); await rm(directory, { recursive: true, force: true }); };
  const stamps = { createdAt: WORKSPACE_TEST_NOW, updatedAt: WORKSPACE_TEST_NOW };
  const owned = { projectId: WORKSPACE_TEST_INPUT.projectId, ...stamps };
  try {
    await db.transaction(async (tx) => {
      await tx.insert(schema.ProjectTable).values([
        { id: WORKSPACE_TEST_INPUT.projectId, userId: WORKSPACE_TEST_INPUT.userId, name: 'Synthetic', ...stamps },
        { id: 'other-project', userId: WORKSPACE_TEST_INPUT.userId, name: 'Other synthetic', ...stamps },
      ]);
      await tx.insert(schema.BookNodeTable).values([
        { ...owned, id: 'chapter', title: 'Chapter', kind: 'chapter', bookOrder: 1, positionX: 0, positionY: 0 },
        { ...owned, id: 'drift', title: 'Drift', kind: 'drift', positionX: 10, positionY: 10 },
      ]);
      await tx.insert(schema.NodeContentTable).values({ nodeId: 'chapter', contentJson: WORKSPACE_TEST_BODY, ...stamps });
      await tx.insert(schema.StorylineTable).values(['main', 'support'].map((id, orderKey) => ({ ...owned, id, name: id, color: '#778899', orderKey })));
      await tx.insert(schema.NodeStorylineLinkTable).values({ nodeId: 'chapter', storylineId: 'main', isPrimary: true });
      await tx.insert(schema.ElementCategoryTable).values({ ...owned, id: 'category', name: 'Category', color: '#778899' });
      await tx.insert(schema.BookElementTable).values({ ...owned, id: 'element', categoryId: 'category', name: 'Element', contentJson: WORKSPACE_TEST_BODY });
      await tx.insert(schema.ProjectAssetTable).values({ id: 'asset', projectId: owned.projectId, createdAt: stamps.createdAt, kind: 'image', sourceMime: 'image/png', sourceSizeBytes: 1, sourceSha256: 'a'.repeat(64), width: 1, height: 1 });
      await tx.insert(schema.LibraryItemTable).values({ ...owned, id: 'library', kind: 'text', title: 'Library', bodyJson: WORKSPACE_TEST_BODY });
      await tx.insert(schema.CommentTable).values({ ...owned, id: 'comment', bodyJson: WORKSPACE_TEST_BODY });
      await tx.insert(schema.CommentActionTable).values({ ...owned, id: 'action', commentId: 'comment', kind: 'apply' });
      await tx.insert(schema.EntityRelationTypeTable).values({ ...owned, id: 'type', name: 'Related', normalizedName: 'related', orientation: 'directed' });
      await tx.insert(schema.EntityRelationTypeEndpointKindTable).values([{ relationTypeId: 'type', side: 'source', entityKind: 'node' }, { relationTypeId: 'type', side: 'target', entityKind: 'element' }]);
      await tx.insert(schema.EntityRelationTable).values({ ...owned, id: 'relation', fromKind: 'node', fromId: 'chapter', toKind: 'element', toId: 'element', relationTypeId: 'type' });
      await tx.insert(schema.BlockSectionTable).values({ ...owned, id: 'section', chapterId: 'chapter', blockIdsJson: '[]' });
      await tx.insert(schema.BookActTable).values({ ...owned, id: 'act', name: 'Act', driftNodeId: 'drift' });
      await tx.insert(schema.DriftGroupTable).values({ ...owned, id: 'group', name: 'Group' });
      await tx.insert(schema.TimelineMarkerTable).values({ ...owned, id: 'marker', narrativeOrder: 1, label: 'Marker', driftNodeId: 'drift' });
      await tx.insert(schema.SyncGenerationTable).values({ ...owned, syncGenerationId: 'workspace-generation', projectSyncId: 'workspace-sync', generationNumber: 1, status: 'active' });
    });
    return { gateway, db, capture: () => captureWorkspaceProjection(WORKSPACE_TEST_INPUT),
      close,
    };
  } catch (error) {
    await close(); throw error;
  }
}
