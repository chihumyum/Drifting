import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import * as schema from '../schema/drizzle';
import { useDataStore } from '../store/data-store';
import { useProjectStore } from '../store/project-store';
import { createSyncMutationV1, type SyncChangeSetV1 } from '../sync/protocol';
import { applyVerifiedRemoteChangeSetInTransaction, invalidateSqliteReducerStateCache } from '../sync/reducer/sqlite-materializer';
import { productionSyncDomainMaterializationKernel } from '../sync/reducer/production-domain-kernel';
import { createWorkspaceProjectionRefresh } from './workspace-projection-refresh';
import { captureWorkspaceProjection, type WorkspaceProjectionCapture } from './workspace-projection.service';
import { WORKSPACE_PROJECTION_MAX_CHANGES, WORKSPACE_PROJECTION_SOURCES, type WorkspaceProjectionCollection } from './workspace-projection-sources';
import { createWorkspaceProjectionFixture, WORKSPACE_TEST_INPUT as INPUT, WORKSPACE_TEST_NOW as NOW } from './workspace-projection.test-support';

const cleanups: Array<() => Promise<void> | void> = [];
async function fixture() { const value = await createWorkspaceProjectionFixture(); cleanups.push(value.close); return value; }
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); invalidateSqliteReducerStateCache(); });

async function compare(capture: WorkspaceProjectionCapture) {
  const full = (await captureWorkspaceProjection(INPUT))!;
  expect(capture.data).toEqual(full.data);
  expect([...capture.data.trashedEntityIds]).toEqual([...full.data.trashedEntityIds]);
  expect(capture.project).toEqual(full.project);
  expect(capture.coverage).toEqual(full.coverage);
}

const edits: Array<[WorkspaceProjectionCollection, string]> = [
  ['project', "UPDATE project SET name='Changed' WHERE id='synthetic-workspace'"],
  ['nodes', "UPDATE book_node SET title='Changed', position_x=42 WHERE id='chapter'"],
  ['storylines', "UPDATE storylines SET color='#112233' WHERE id='main'"],
  ['elements', "UPDATE element SET aliases_json='[\"Changed\"]' WHERE id='element'"],
  ['categories', "UPDATE element_category SET layout_mode='pinned', grid_x=4 WHERE id='category'"],
  ['assets', "DELETE FROM project_asset WHERE id='asset'"],
  ['library', "UPDATE library_item SET title='Changed' WHERE id='library'"],
  ['comments', "UPDATE comment SET status='resolved' WHERE id='comment'"],
  ['comment-actions', "UPDATE comment_action SET status='applied' WHERE id='action'"],
  ['relations', "UPDATE entity_relation SET from_id='drift' WHERE id='relation'"],
  ['relation-types', "INSERT INTO entity_relation_type_endpoint_kind VALUES ('type', 'source', 'storyline')"],
  ['sections', "UPDATE block_section SET block_ids_json='[\"changed\"]' WHERE id='section'"],
  ['acts', "UPDATE book_act SET start_order=3 WHERE id='act'"],
  ['drift-groups', "UPDATE drift_group SET color='#112233' WHERE id='group'"],
  ['markers', "UPDATE timeline_marker SET label='Changed' WHERE id='marker'"],
  ['memberships', "UPDATE node_storyline_link SET storyline_id='support' WHERE node_id='chapter'"],
];

describe('workspace projection invalidation coverage', () => {
  it.each(edits)('matches a full snapshot after an actual %s row change', async (collection, statement) => {
    const { db, capture } = await fixture();
    const before = (await capture())!;
    await db.run(statement);
    const selected = (await captureWorkspaceProjection({ ...INPUT, previous: before }))!;
    expect(selected.mode).toBe('changes'); expect(selected.readCollections).toContain(collection);
    if (collection === 'nodes') { expect(selected.nodeRead).toBe('changed'); expect(selected.readCollections).not.toContain('memberships'); }
    await compare(selected);
    if (!['elements', 'categories'].includes(collection)) expect(selected.data.bookElements).toBe(before.data.bookElements);
  });

  it('promotes node ordering and same-ID replacement to a complete node collection', async () => {
    const { db, capture } = await fixture();
    await db.insert(schema.BookNodeTable).values({ id: 'second', projectId: INPUT.projectId, title: 'Second', kind: 'chapter', bookOrder: 1, positionX: 0, positionY: 0, createdAt: NOW, updatedAt: NOW });
    const before = (await capture())!;
    await db.transaction(async (tx) => {
      await tx.delete(schema.BookNodeTable).where(eq(schema.BookNodeTable.id, 'chapter'));
      await tx.insert(schema.BookNodeTable).values({ id: 'chapter', projectId: INPUT.projectId, title: 'Chapter', kind: 'chapter', bookOrder: 1, positionX: 0, positionY: 0, createdAt: NOW, updatedAt: NOW });
    });
    const replaced = (await captureWorkspaceProjection({ ...INPUT, previous: before }))!;
    expect(replaced.nodeRead).toBe('all'); await compare(replaced);
    expect(replaced.data.bookNodes.filter((node) => node.kind === 'chapter').map(({ id }) => id)).toEqual(['second', 'chapter']);
    await db.update(schema.BookNodeTable).set({ bookOrder: 0 }).where(eq(schema.BookNodeTable.id, 'chapter'));
    const moved = (await captureWorkspaceProjection({ ...INPUT, previous: replaced }))!;
    expect(moved.nodeRead).toBe('all'); await compare(moved);
  });

  it('refuses coverage from a copied capture or a replaced database client', async () => {
    const first = await fixture(); const before = (await first.capture())!;
    const copied = (await captureWorkspaceProjection({ ...INPUT, previous: { ...before } }))!;
    expect(copied.mode).toBe('full');
    await first.close(); const second = await fixture();
    await second.db.update(schema.BookNodeTable).set({ title: 'Other database' }).where(eq(schema.BookNodeTable.id, 'chapter'));
    const rebound = (await captureWorkspaceProjection({ ...INPUT, previous: before }))!;
    expect(rebound.mode).toBe('full'); await compare(rebound);
  });

  it('invalidates both project scopes when an unlinked node changes ownership and identity', async () => {
    const { db, capture } = await fixture();
    await db.insert(schema.BookNodeTable).values({ id: 'movable', projectId: INPUT.projectId, title: 'Movable', kind: 'chapter', bookOrder: 2, positionX: 0, positionY: 0, createdAt: NOW, updatedAt: NOW });
    const before = (await capture())!;
    const otherInput = { ...INPUT, projectId: 'other-project' };
    const otherBefore = (await captureWorkspaceProjection(otherInput))!;
    await db.update(schema.BookNodeTable).set({ projectId: otherInput.projectId, id: 'moved' }).where(eq(schema.BookNodeTable.id, 'movable'));
    const after = (await captureWorkspaceProjection({ ...INPUT, previous: before }))!;
    const otherAfter = (await captureWorkspaceProjection({ ...otherInput, previous: otherBefore }))!;
    expect(after.nodeRead).toBe('all'); expect(otherAfter.nodeRead).toBe('all');
    await compare(after);
    expect(otherAfter.data).toEqual((await captureWorkspaceProjection(otherInput))!.data);
    expect(otherAfter.data.bookNodes.map(({ id }) => id)).toEqual(['moved']);
  });

  it('rejects a delayed row-scoped capture after a local edit and recovers through full capture', async () => {
    const { db, capture } = await fixture(); const initial = (await capture())!;
    const epoch = useDataStore.getState().requestWorkspaceProjection(INPUT.projectId, 'loading');
    useDataStore.getState().commitWorkspaceProjection(INPUT.projectId, epoch, initial.data);
    useProjectStore.getState().setCurrentProject(initial.project);
    let pause = false; let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const captured = new Promise<void>((resolve) => { entered = resolve; });
    const results: WorkspaceProjectionCapture[] = [];
    const queue = createWorkspaceProjectionRefresh({ ...INPUT,
      capture: async (input) => {
        const result = await captureWorkspaceProjection(input);
        if (pause) { expect(result!.nodeRead).toBe('changed'); entered(); await gate; }
        return result;
      },
      onPublished: (value) => results.push(value), onMissing: () => {}, onError: (error) => { throw error; },
    });
    cleanups.push(() => { release(); queue.dispose(); });
    queue.requestChanges(); await queue.flush();
    pause = true;
    await db.update(schema.BookNodeTable).set({ title: 'Remote' }).where(eq(schema.BookNodeTable.id, 'chapter'));
    queue.requestChanges(); const running = queue.flush(); await captured;
    await db.update(schema.BookNodeTable).set({ title: 'New local edit' }).where(eq(schema.BookNodeTable.id, 'chapter'));
    useDataStore.getState().updateBookNode('chapter', { title: 'New local edit' });
    pause = false; release(); await running;
    expect(results).toHaveLength(1); expect(useDataStore.getState().workspaceProjectionStatus).toBe('refreshing');
    await queue.flush(); expect(results).toHaveLength(2); expect(results[1]!.mode).toBe('full');
    expect(useDataStore.getState().bookNodes.find(({ id }) => id === 'chapter')!.title).toBe('New local edit');
    await compare(results[1]!);
  });

  it('records every queried table and column, including child dependencies', async () => {
    const { gateway } = await fixture();
    for (const { table } of WORKSPACE_PROJECTION_SOURCES) {
      const columns = gateway.database.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
      const trigger = gateway.database.prepare('SELECT sql FROM sqlite_schema WHERE name = ?').get(`workspace_projection_${table}_update`) as { sql: string };
      expect(trigger).toBeDefined();
      for (const { name } of columns) expect(trigger.sql).toContain(`OLD."${name}" IS NOT NEW."${name}"`);
    }
    expect(gateway.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('does not invalidate on a no-op write, and tracks changed fields without timestamp changes', async () => {
    const { db, capture } = await fixture(); const before = (await capture())!;
    await db.update(schema.BookNodeTable).set({ title: 'Chapter', updatedAt: NOW }).where(eq(schema.BookNodeTable.id, 'chapter'));
    const unchanged = (await captureWorkspaceProjection({ ...INPUT, previous: before }))!;
    expect(unchanged.coverage).toEqual(before.coverage); expect(unchanged.readCollections).toEqual(['project']);
    expect(unchanged.data.bookNodes).toBe(before.data.bookNodes);
    await db.update(schema.BookNodeTable).set({ title: 'Changed at same time' }).where(eq(schema.BookNodeTable.id, 'chapter'));
    const changed = (await captureWorkspaceProjection({ ...INPUT, previous: unchanged }))!;
    expect(changed.data.bookNodes.find(({ id }) => id === 'chapter')?.title).toBe('Changed at same time');
    await compare(changed);
  });

  it('rolls invalidation back with an aborted author transaction', async () => {
    const { db, capture } = await fixture(); const before = (await capture())!;
    await expect(db.transaction(async (tx) => {
      await tx.update(schema.BookNodeTable).set({ title: 'Aborted' }).where(eq(schema.BookNodeTable.id, 'chapter'));
      throw new Error('Synthetic rollback');
    })).rejects.toThrow('Synthetic rollback');
    const after = (await captureWorkspaceProjection({ ...INPUT, previous: before }))!;
    expect(after.coverage).toEqual(before.coverage); expect(after.data.bookNodes).toBe(before.data.bookNodes);
    await compare(after);
  });

  it.each([
    ['chapter', 'nodes', 'sections', 'memberships'],
    ['drift', 'nodes', 'acts', 'markers'],
    ['category', 'categories', 'elements'],
    ['comment', 'comments', 'comment-actions'],
    ['main', 'storylines', 'memberships'],
  ])('captures the actual cascade closure when deleting %s', async (id, ...collections) => {
    const { db, capture } = await fixture(); const before = (await capture())!;
    const table = id === 'category' ? schema.ElementCategoryTable : id === 'comment' ? schema.CommentTable : id === 'main' ? schema.StorylineTable : schema.BookNodeTable;
    await db.delete(table).where(eq(table.id, id));
    const after = (await captureWorkspaceProjection({ ...INPUT, previous: before }))!;
    expect(after.mode).toBe('changes'); for (const collection of collections) expect(after.readCollections).toContain(collection);
    await compare(after);
  });

  it('preserves full trash iteration order across changes to different kinds', async () => {
    const { db, capture } = await fixture();
    await db.update(schema.BookElementTable).set({ deletedAt: NOW }).where(eq(schema.BookElementTable.id, 'element'));
    const before = (await capture())!;
    await db.update(schema.BookNodeTable).set({ deletedAt: NOW }).where(eq(schema.BookNodeTable.id, 'chapter'));
    const after = (await captureWorkspaceProjection({ ...INPUT, previous: before }))!;
    await compare(after); expect([...after.data.trashedEntityIds]).toEqual(['node:chapter', 'element:element']);
  });

  it('includes an earlier unnotified collection when a later refresh occurs', async () => {
    const { db, capture } = await fixture(); const before = (await capture())!;
    await db.update(schema.LibraryItemTable).set({ title: 'No event delivered' }).where(eq(schema.LibraryItemTable.id, 'library'));
    await db.update(schema.BookNodeTable).set({ title: 'Later event' }).where(eq(schema.BookNodeTable.id, 'chapter'));
    const after = (await captureWorkspaceProjection({ ...INPUT, previous: before }))!;
    expect(after.readCollections).toEqual(expect.arrayContaining(['nodes', 'library'])); await compare(after);
  });

  it('coalesces repeated identities and falls back after bounded coverage expires', async () => {
    const { db, capture } = await fixture(); const before = (await capture())!;
    await db.transaction(async (tx) => {
      for (let index = 0; index < WORKSPACE_PROJECTION_MAX_CHANGES + 2; index += 1) {
        await tx.update(schema.BookNodeTable).set({ title: `Synthetic ${index}` }).where(eq(schema.BookNodeTable.id, 'chapter'));
      }
    });
    const records = await db.select().from(schema.WorkspaceProjectionChangeTable).where(eq(schema.WorkspaceProjectionChangeTable.projectId, INPUT.projectId));
    expect(records).toHaveLength(1);
    const after = (await captureWorkspaceProjection({ ...INPUT, previous: before }))!;
    expect(after.mode).toBe('full'); expect(after.coverage!.retainedAfter).toBeGreaterThan(before.coverage!.revision);
    await compare(after);
  });

  it('bounds distinct changed identities while retaining the newest covered delta', async () => {
    const { db, capture } = await fixture(); const before = (await capture())!;
    await db.run(`WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n < ${WORKSPACE_PROJECTION_MAX_CHANGES + 12})
      INSERT INTO book_node(id, project_id, title, position_x, position_y, created_at, updated_at)
      SELECT 'bulk-' || n, 'synthetic-workspace', 'Synthetic', 0, 0, '${NOW}', '${NOW}' FROM ids`);
    const records = await db.select().from(schema.WorkspaceProjectionChangeTable).where(eq(schema.WorkspaceProjectionChangeTable.projectId, INPUT.projectId));
    expect(records.length).toBeGreaterThan(0); expect(records.length).toBeLessThanOrEqual(WORKSPACE_PROJECTION_MAX_CHANGES);
    const after = (await captureWorkspaceProjection({ ...INPUT, previous: before }))!;
    expect(after.mode).toBe('full'); await compare(after);
    await db.update(schema.BookNodeTable).set({ title: 'Newest' }).where(eq(schema.BookNodeTable.id, 'chapter'));
    const latest = (await captureWorkspaceProjection({ ...INPUT, previous: after }))!;
    expect(latest.mode).toBe('changes'); await compare(latest);
  });

  it.each(['generation', 'reset', 'unknown'] as const)('uses full capture after %s coverage invalidation', async (cause) => {
    const { db, capture } = await fixture(); const before = (await capture())!;
    if (cause === 'generation') await db.update(schema.SyncGenerationTable).set({ updatedAt: '2026-09-12T01:00:00.000Z' }).where(eq(schema.SyncGenerationTable.syncGenerationId, 'workspace-generation'));
    if (cause === 'reset') await db.delete(schema.WorkspaceProjectionClockTable).where(eq(schema.WorkspaceProjectionClockTable.projectId, INPUT.projectId));
    if (cause === 'unknown') {
      await db.update(schema.BookNodeTable).set({ title: 'Changed' }).where(eq(schema.BookNodeTable.id, 'chapter'));
      await db.update(schema.WorkspaceProjectionChangeTable).set({ collection: 'unknown-extension' }).where(eq(schema.WorkspaceProjectionChangeTable.projectId, INPUT.projectId));
    }
    const after = (await captureWorkspaceProjection({ ...INPUT, previous: before }))!;
    expect(after.mode).toBe('full'); await compare(after);
  });

  it('isolates projects and invalidates a same-ID project recreation', async () => {
    const { db, capture } = await fixture(); const before = (await capture())!;
    await db.update(schema.ProjectTable).set({ name: 'Other changed' }).where(eq(schema.ProjectTable.id, 'other-project'));
    const unchanged = (await captureWorkspaceProjection({ ...INPUT, previous: before }))!;
    expect(unchanged.coverage).toEqual(before.coverage); expect(unchanged.data.bookNodes).toBe(before.data.bookNodes);
    await db.delete(schema.ProjectTable).where(eq(schema.ProjectTable.id, INPUT.projectId));
    await db.insert(schema.ProjectTable).values({ id: INPUT.projectId, userId: INPUT.userId, name: 'Recreated', createdAt: NOW, updatedAt: NOW });
    const after = (await captureWorkspaceProjection({ ...INPUT, previous: before }))!;
    expect(after.mode).toBe('full'); expect(after.coverage!.epoch).not.toBe(before.coverage!.epoch); expect(after.data.bookNodes).toEqual([]);
  });

  it('observes historical materialization outside the current remote mutation targets', async () => {
    const { db, capture } = await fixture();
    const remote = async (sequence: number, kind: string, id: string, field: string, value: string) => {
      const changeSet: SyncChangeSetV1 = {
        protocol: 'drifting.sync.changeset', protocolVersion: 1, payloadVersion: 1,
        projectId: INPUT.projectId, projectSyncId: 'workspace-sync', syncGenerationId: 'workspace-generation',
        changeSetId: `workspace-remote:epoch:${sequence}`, writerId: 'workspace-remote', writerEpoch: 'epoch', deviceSeq: sequence,
        hlc: { wallMs: 1_700_000_000_000 + sequence, counter: 0 },
        mutations: [await createSyncMutationV1({ index: 0, target: { family: 'entity', kind, id, incarnation: 0 }, action: 'field.set', payloadVersion: 1, payload: { field, value } })],
      };
      return db.transaction((tx) => applyVerifiedRemoteChangeSetInTransaction(tx, {
        changeSet, identity: { installationId: 'synthetic-install', createWriterIdentity: () => ({ writerId: 'workspace-local', writerEpoch: 'epoch' }) },
        clock: { nowMs: 1_700_000_000_100, nowIso: NOW }, kernel: productionSyncDomainMaterializationKernel,
      }));
    };
    await remote(1, 'element', 'element', 'name', 'Canonical element');
    // Synthetic stale materialized row: the next reducer pass restores its
    // historical winner even though that element is absent from the new wire mutation.
    await db.update(schema.BookElementTable).set({ name: 'Stale projection' }).where(eq(schema.BookElementTable.id, 'element'));
    const before = (await capture())!;
    const applied = await remote(2, 'node', 'chapter', 'title', 'Remote chapter');
    expect(applied.effects.some((effect) => effect.materialize && effect.target.kind === 'element')).toBe(true);
    const after = (await captureWorkspaceProjection({ ...INPUT, previous: before }))!;
    expect(after.readCollections).toEqual(expect.arrayContaining(['elements', 'nodes']));
    expect(after.data.bookElements[0]!.name).toBe('Canonical element'); await compare(after);
  });

  it('connects covered reads to the project queue while explicit repair wins over narrow requests', async () => {
    const { db, capture } = await fixture(); const initial = (await capture())!;
    const epoch = useDataStore.getState().requestWorkspaceProjection(INPUT.projectId, 'loading');
    useDataStore.getState().commitWorkspaceProjection(INPUT.projectId, epoch, initial.data);
    useProjectStore.getState().setCurrentProject(initial.project);
    const results: WorkspaceProjectionCapture[] = [];
    const queue = createWorkspaceProjectionRefresh({ ...INPUT, onPublished: (value) => results.push(value), onMissing: () => {}, onError: (error) => { throw error; } });
    cleanups.push(() => queue.dispose());
    queue.requestChanges(); await queue.flush(); expect(results[results.length - 1]!.mode).toBe('full');
    await db.update(schema.BookNodeTable).set({ title: 'Second' }).where(eq(schema.BookNodeTable.id, 'chapter'));
    queue.requestChanges(); await queue.flush(); expect(results[results.length - 1]!.mode).toBe('changes');
    expect(results[results.length - 1]!.readCollections).not.toContain('elements'); await compare(results[results.length - 1]!);
    queue.requestChanges(); queue.request(); queue.requestChanges(); await queue.flush(); expect(results[results.length - 1]!.mode).toBe('full');
    const clock = await db.select().from(schema.WorkspaceProjectionClockTable).where(and(eq(schema.WorkspaceProjectionClockTable.projectId, INPUT.projectId)));
    expect(clock).toHaveLength(1);
  });
});
