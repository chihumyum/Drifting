import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { ProductFileBackedSqliteGateway } from '../../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import { installHeadlessDatabaseClient } from '../../lib/db';
import { BookElementTable, BookNodeTable, LibraryItemTable, NodeContentTable, ProjectTable, SyncGenerationTable } from '../../schema/drizzle';
import { useDataStore } from '../../store/data-store';
import { useProjectStore } from '../../store/project-store';
import { createAuthoredTransactionRunner } from '../../sync/journal/authored-transaction';
import { createWorkspaceProjectionRefresh } from '../workspace-projection-refresh';
import { captureWorkspaceProjection, type WorkspaceProjectionCapture } from '../workspace-projection.service';

const INPUT = { projectId: 'synthetic-workspace', userId: 'synthetic-user' };
const NOW = '2026-09-12T00:00:00.000Z';
type Gateway = ProductFileBackedSqliteGateway;

function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value, (_key, item) =>
    item instanceof Set ? [...item] : item instanceof Uint8Array ? Array.from(item) : item)).digest('hex');
}

/** Include every persistent table, including journal and projection cursors. */
function databaseHash(gateway: Gateway) {
  const tables = gateway.database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
  return digest(tables.map(({ name }) => [name, gateway.database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map(digest).sort()]));
}

async function hold(value: unknown): Promise<never> {
  assert(process.send);
  process.send(value);
  // Freeze at the observed boundary; pending timers must not race SIGKILL.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error('Crash boundary unexpectedly resumed.');
}

export async function runWorkspaceCrashWorker(args: string[]) {
  const [mode, databasePath, boundary, scenario, seedText] = args;
  assert(databasePath && boundary && ['write', 'recover'].includes(mode ?? ''));
  assert(scenario === 'node-metadata' || scenario === 'collection-change' || scenario === 'library-change');
  const seed = Number(seedText);
  assert(Number.isSafeInteger(seed) && seed > 0);
  const gateway = new ProductFileBackedSqliteGateway(databasePath);
  const db = gateway.client();
  const uninstall = installHeadlessDatabaseClient(db, 'synthetic-workspace-crash.db');
  let queue: ReturnType<typeof createWorkspaceProjectionRefresh> | undefined;
  try {
    if (mode === 'write') {
      await db.transaction(async (tx) => {
        const stamps = { createdAt: NOW, updatedAt: NOW };
        const owned = { ...stamps, projectId: INPUT.projectId };
        await tx.insert(ProjectTable).values([
          { ...stamps, userId: INPUT.userId, id: INPUT.projectId, name: 'Synthetic' },
          { ...stamps, id: 'other-project', userId: INPUT.userId, name: 'Other synthetic' },
        ]);
        await tx.insert(BookNodeTable).values({ ...owned, id: 'node', title: 'Before', kind: 'chapter', bookOrder: 1, positionX: 0, positionY: 0 });
        await tx.insert(NodeContentTable).values({ ...stamps, nodeId: 'node', contentJson: '{"type":"doc","content":[]}' });
        await tx.insert(BookElementTable).values({ ...owned, id: 'element', name: 'Before', contentJson: '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Synthetic body."}]}]}' });
        await tx.insert(LibraryItemTable).values({ ...owned, id: 'library', kind: 'text', title: 'Before', bodyJson: '{"type":"doc","content":[]}' });
        await tx.insert(SyncGenerationTable).values({ ...owned, projectSyncId: 'synthetic-sync', syncGenerationId: 'synthetic-generation', generationNumber: 1, status: 'active' });
      });
    }
    const initial = (await captureWorkspaceProjection(INPUT))!;
    assert(initial); assert.equal(initial.mode, 'full');
    const epoch = useDataStore.getState().requestWorkspaceProjection(INPUT.projectId, 'loading');
    assert(useDataStore.getState().commitWorkspaceProjection(INPUT.projectId, epoch, initial.data, undefined, initial.coverage?.epoch ?? null));
    useProjectStore.getState().setCurrentProject(initial.project);
    let stage: 'warming' | 'authored' | 'refresh' = 'warming';
    let published: WorkspaceProjectionCapture | undefined;
    let observedCapture: WorkspaceProjectionCapture | undefined;
    const baselineHash = databaseHash(gateway);
    const ready = () => ({ ready: true, boundary, scenario, seed, baselineHash, databaseHash: databaseHash(gateway), captureMode: observedCapture?.mode, nodeRead: observedCapture?.nodeRead, elementRead: observedCapture?.elementRead, libraryRead: observedCapture?.libraryRead });
    queue = createWorkspaceProjectionRefresh({
      ...INPUT,
      onPublished: (value) => { published = value; useProjectStore.getState().setCurrentProject(value.project); },
      onMissing: () => { throw new Error('Synthetic project unexpectedly missing'); },
      onError: (error) => { throw error; },
      capture: async (input) => {
        const value = await captureWorkspaceProjection(input);
        if (stage === 'refresh' && mode === 'write') {
          assert(value); assert.equal(value.mode, 'changes');
          assert.equal(value.nodeRead, scenario === 'node-metadata' ? 'changed' : 'reuse');
          assert.equal(value.elementRead, scenario === 'collection-change' ? 'changed' : 'reuse');
          assert.equal(value.libraryRead, scenario === 'library-change' ? 'changed' : 'reuse');
          observedCapture = value;
          if (boundary === 'capture-before-publish') await hold(ready());
        }
        return value;
      },
    });
    queue.requestChanges(); await queue.flush(); assert(published);
    assert.equal(published.mode, 'full');

    if (mode === 'write') {
      stage = 'authored';
      const commit = gateway.commit.bind(gateway);
      gateway.commit = async (id) => {
        if (stage === 'authored' && boundary === 'authored-before-commit') await hold(ready());
        await commit(id);
        if (stage === 'authored' && boundary === 'authored-after-commit') await hold(ready());
      };
      const runAuthored = createAuthoredTransactionRunner({
        database: () => db,
        identity: async () => ({ installationId: 'synthetic-install', createWriterIdentity: () => ({ writerId: 'synthetic-writer', writerEpoch: 'synthetic-epoch' }) }),
        clock: () => ({ nowMs: 1_700_000_000_000 + seed, nowIso: NOW }),
        syncGenerationIds: { createSyncGenerationId: () => 'synthetic-generation', createProjectSyncId: () => 'synthetic-sync' },
      });
      await runAuthored(INPUT.projectId, 'workspace.acceptance', async ({ tx, changes }) => {
        const value = `After ${seed}`;
        if (scenario === 'node-metadata') await tx.update(BookNodeTable).set({ title: value }).where(eq(BookNodeTable.id, 'node'));
        else if (scenario === 'library-change') await tx.update(LibraryItemTable).set({ title: value }).where(eq(LibraryItemTable.id, 'library'));
        else await tx.update(BookElementTable).set({ name: value }).where(eq(BookElementTable.id, 'element'));
        changes.add({ action: 'field.set', target: { family: 'entity', kind: scenario === 'node-metadata' ? 'node' : scenario === 'library-change' ? 'library-item' : 'element', id: scenario === 'node-metadata' ? 'node' : scenario === 'library-change' ? 'library' : 'element', incarnation: 0 }, payload: { field: scenario === 'collection-change' ? 'name' : 'title', value } });
      });
      stage = 'refresh';
      queue.requestChanges();
      if (boundary === 'queue-waiting') await hold(ready());
      await queue.flush();
      assert.equal(published!.mode, 'changes');
      if (boundary === 'published') await hold(ready());
      throw new Error(`Boundary not reached: ${boundary}`);
    }

    const changed = boundary !== 'authored-before-commit';
    assert.equal(published!.data.bookNodes[0]!.title, changed && scenario === 'node-metadata' ? `After ${seed}` : 'Before');
    assert.equal(published!.data.bookElements[0]!.name, changed && scenario === 'collection-change' ? `After ${seed}` : 'Before');
    assert.equal(published!.data.libraryItems[0]!.title, changed && scenario === 'library-change' ? `After ${seed}` : 'Before');
    const full = (await captureWorkspaceProjection(INPUT))!;
    assert.deepEqual(published!.data, full.data);
    assert.equal(databaseHash(gateway), baselineHash);
    assert.equal(gateway.database.prepare("SELECT name FROM project WHERE id='other-project'").get()!.name, 'Other synthetic');
    assert.equal(gateway.database.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    assert.deepEqual(gateway.database.prepare('PRAGMA foreign_key_check').all(), []);
    assert(process.send);
    await new Promise<void>((resolve, reject) => process.send!({ recovered: true, boundary, scenario, seed, databaseHash: baselineHash, projectionHash: digest(full.data), captureMode: published!.mode, checks: ['fixture-oracle', 'uncached-full-capture', 'persistent-state-unchanged', 'project-isolation', 'integrity', 'foreign-keys'] }, (error) => error ? reject(error) : resolve()));
  } finally { queue?.dispose(); uninstall(); await gateway.close(); }
}
