import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as Y from 'yjs';
import { afterEach, describe, expect, it } from 'vitest';

import { installHeadlessRendererGlobals } from './headless-globals';
import { SEED_PRESETS, allocateSeedLengths } from '../renderer/services/sample-project/presets';
import fixtures from '../renderer/services/sample-project/assets/manifest.json';

const preset = SEED_PRESETS.lite;
const expected = Object.fromEntries(Object.entries(preset).filter(([, value]) => value && typeof value === 'object' && 'count' in value).map(([key, value]) => [key, (value as { count: number }).count]));

const directories: string[] = [];
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// Install browser storage before dynamically loading renderer stores.
installHeadlessRendererGlobals();
const { LOCAL_LIBRARY_USER_ID, seedDevelopmentDatabase } = await import('./seed');
const { LOCAL_USER_ID } = await import('../renderer/store/auth');
const { invalidateSqliteReducerStateCache } = await import('../renderer/sync/reducer/sqlite-materializer');

afterEach(() => {
  invalidateSqliteReducerStateCache();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function count(database: DatabaseSync, sql: string): number {
  return Number((database.prepare(sql).get() as { n: number }).n);
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'drifting-seed-'));
  directories.push(directory);
  return directory;
}

describe('development seed', () => {
  it('creates a lite, connected and journaled library with real prose, assets and resumable conversations, once', async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, 'databases', 'drifting-library.db');
    const appLocalDataDirectory = join(directory, 'isolated-app');
    const first = await seedDevelopmentDatabase({ databasePath, appLocalDataDirectory, preset: 'lite' });
    expect(first.seeded).toBe(true);
    expect(first.statistics?.bodies.chapters.totalWords).toBe(150_000);
    expect(first.statistics?.bodies.elements.totalWords).toBe(50_000);
    expect(first.statistics?.bodies.inspirations.totalWords).toBe(20_000);
    expect(first.statistics?.bodies.materialNotes.totalWords).toBe(20_000);
    expect(LOCAL_LIBRARY_USER_ID).toBe(LOCAL_USER_ID);

    const database = new DatabaseSync(databasePath);
    let journalCount: number;
    try {
      expect(database.prepare('SELECT id, user_id AS userId FROM project').all()).toEqual([
        { id: first.projectId, userId: LOCAL_USER_ID },
      ]);
      expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(count(database, "SELECT count(*) AS n FROM book_node WHERE kind = 'chapter'")).toBe(expected.chapters);
      expect(count(database, "SELECT count(*) AS n FROM book_node WHERE kind = 'drift'")).toBe(expected.inspirations);
      expect(count(database, 'SELECT count(*) AS n FROM storylines')).toBe(expected.storylines);
      expect(count(database, 'SELECT count(*) AS n FROM node_storyline_link')).toBe(24);
      expect(count(database, "SELECT count(DISTINCT node_id) AS n FROM node_storyline_link JOIN book_node ON book_node.id = node_id WHERE book_node.kind = 'chapter'")).toBe(expected.chapters);
      expect(count(database, 'SELECT count(*) AS n FROM element_category')).toBe(expected.categories);
      expect(count(database, 'SELECT count(*) AS n FROM element')).toBe(expected.elements);
      expect(count(database, 'SELECT count(*) AS n FROM element_category c WHERE NOT EXISTS (SELECT 1 FROM element e WHERE e.category_id = c.id)')).toBe(0);
      expect(count(database, 'SELECT count(*) AS n FROM entity_relation')).toBe(36);
      expect(count(database, "SELECT count(*) AS n FROM comment WHERE kind = 'todo'")).toBe(expected.todos);
      expect(count(database, "SELECT count(*) AS n FROM comment WHERE kind = 'note'")).toBe(expected.comments);
      expect(count(database, "SELECT count(*) AS n FROM comment WHERE status = 'resolved'")).toBe(5);
      expect(count(database, 'SELECT count(*) AS n FROM comment WHERE target_id IS NULL')).toBeGreaterThan(3);
      expect(count(database, 'SELECT count(*) AS n FROM comment WHERE target_block_id IS NOT NULL')).toBeGreaterThan(0);
      expect(count(database, 'SELECT count(*) AS n FROM material_folder')).toBe(6);
      expect(count(database, 'SELECT count(*) AS n FROM material_folder WHERE parent_folder_id IS NOT NULL')).toBe(2);
      expect(count(database, "SELECT count(*) AS n FROM library_item WHERE kind = 'text'")).toBe(expected.materialNotes);
      expect(count(database, "SELECT count(*) AS n FROM library_item WHERE kind = 'image'")).toBe(4);
      expect(count(database, "SELECT count(*) AS n FROM library_item WHERE kind = 'pdf'")).toBe(2);
      expect(count(database, 'SELECT count(*) AS n FROM project_asset')).toBe(fixtures.length);
      expect(count(database, 'SELECT count(*) AS n FROM library_item i LEFT JOIN project_asset a ON a.id = i.asset_id WHERE i.asset_id IS NOT NULL AND a.id IS NULL')).toBe(0);
      expect(count(database, "SELECT count(*) AS n FROM sync_blob_state WHERE local_state = 'verified'")).toBe(fixtures.length);
      journalCount = count(database, 'SELECT count(*) AS n FROM sync_change_set');
      expect(journalCount).toBeGreaterThan(100);
      expect(count(database, 'SELECT count(*) AS n FROM sync_entity_lifecycle')).toBeGreaterThan(100);

      // Every chapter and inspiration reconstructs from durable CRDT bytes,
      // independently of the disposable content_json cache.
      const nodes = database.prepare('SELECT id FROM book_node').all() as { id: string }[];
      for (const node of nodes) {
        const doc = new Y.Doc();
        try {
          const docId = `node-content:${node.id}`;
          const snapshot = database.prepare('SELECT state_blob AS bytes FROM yjs_snapshots WHERE document_id = ?').get(docId) as { bytes: Uint8Array } | undefined;
          if (snapshot) Y.applyUpdate(doc, snapshot.bytes);
          const updates = database.prepare('SELECT update_blob AS bytes FROM yjs_updates WHERE document_id = ? ORDER BY id').all(docId) as { bytes: Uint8Array }[];
          for (const update of updates) Y.applyUpdate(doc, update.bytes);
          expect(doc.getXmlFragment('default').toString().length, docId).toBeGreaterThan(20);
        } finally { doc.destroy(); }
      }
      const assets = database.prepare('SELECT id, source_sha256 AS hash, source_size_bytes AS size, kind FROM project_asset').all() as { id: string; hash: string; size: number; kind: string }[];
      for (const asset of assets) {
        const fixture = fixtures.find(entry => entry.sha256 === asset.hash)!;
        const assetDirectory = join(appLocalDataDirectory, 'assets', first.projectId!, asset.id);
        const source = readFileSync(join(assetDirectory, `source.${asset.kind === 'image' ? 'png' : 'pdf'}`));
        expect(sha256(source)).toBe(asset.hash);
        expect(source.length).toBe(asset.size);
        for (const [variant, metadata] of Object.entries(fixture.variants)) {
          expect(sha256(readFileSync(join(assetDirectory, `${variant}.jpg`)))).toBe(metadata.sha256);
        }
      }
      const objects = database.prepare('SELECT storage_ref AS ref, stored_sha256 AS hash FROM sync_local_object WHERE object_kind = ?').all('blob') as { ref: string; hash: string }[];
      expect(objects).toHaveLength(fixtures.length);
      for (const object of objects) {
        expect(object.ref).toMatch(/^syncobj:[a-f0-9-]+$/);
        const token = object.ref.slice('syncobj:'.length);
        expect(sha256(readFileSync(join(appLocalDataDirectory, 'sync-objects', token.slice(0, 2), `${token}.object`)))).toBe(object.hash);
      }
      // Ordinary edits in an existing seed library must survive the next run.
      database.prepare("UPDATE project SET name = '开发者已经改过的示例' WHERE id = ?").run(first.projectId);
    } finally { database.close(); }

    const again = await seedDevelopmentDatabase({ databasePath, appLocalDataDirectory, preset: 'lite' });
    // A later run reports the library's existing project, for launchers that open it.
    expect(again).toEqual({ seeded: false, databasePath, projectId: first.projectId });
    const reopened = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(reopened.prepare('SELECT name FROM project').get()).toEqual({ name: '开发者已经改过的示例' });
      expect(count(reopened, 'SELECT count(*) AS n FROM sync_change_set')).toBe(journalCount);
    } finally { reopened.close(); }
    expect(readdirSync(join(directory, 'databases')).some(name => name.includes('.seed-'))).toBe(false);

    // Read through production history/recovery APIs after closing/reopening.
    const { OfflineProductDatabase } = await import('./offline-database');
    const { createAgentConversationRepository } = await import('../renderer/sqlite-repo/agent-conversation-repo');
    const { createAgentRuntimePersistenceRepository } = await import('../renderer/sqlite-repo/agent-runtime-persistence-repo');
    const { recoverAgentRuntimeSnapshot } = await import('../renderer/lib/agent/runtime/recovery');
    const { loadCanonicalAgentTranscript } = await import('../renderer/lib/agent/runtime/recovered-transcript');
    const product = new OfflineProductDatabase(databasePath, { migrate: false });
    await product.open();
    try {
      const conversations = createAgentConversationRepository();
      const runtime = createAgentRuntimePersistenceRepository(product.client);
      const list = (await conversations.listByProject(first.projectId!)).filter(row => row.title.startsWith('示例讨论'));
      expect(list).toHaveLength(expected.conversations);
      const observedRounds: number[] = [];
      for (const row of list) {
        const conversation = (await conversations.get(row.id))!;
        const snapshot = (await runtime.loadRecoverySnapshot(conversation.runtimeSessionId!))!;
        const rounds = snapshot.turns.length;
        observedRounds.push(rounds);
        expect(snapshot.turns.every(turn => turn.status === 'completed')).toBe(true);
        const recovered = await recoverAgentRuntimeSnapshot(snapshot);
        expect(recovered.providerHistory).toHaveLength(rounds * 2 + Math.floor((rounds + 1) / 3) * 2);
        const transcript = (await loadCanonicalAgentTranscript(conversation.runtimeSessionId!, runtime))!;
        expect(transcript.filter(message => message.kind === 'user')).toHaveLength(rounds);
        expect(transcript.filter(message => message.kind === 'assistant')).toHaveLength(rounds);
        expect(transcript.filter(message => message.kind === 'thinking')).toHaveLength(rounds);
        expect(transcript.filter(message => message.kind === 'tool')).toHaveLength(Math.floor((rounds + 1) / 3));
      }
      expect(observedRounds.sort((a, b) => a - b)).toEqual(allocateSeedLengths(preset.conversations, 109).sort((a, b) => a - b));
    } finally { await product.close(); }
  }, 300_000);

  it('publishes no partial project when a scenario fails and allows a retry', async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, 'library.db');
    const scenarioPath = join(directory, 'scenario.json');
    writeFileSync(scenarioPath, JSON.stringify({ schemaVersion: 1, name: 'failing-seed', steps: [
      { kind: 'workspace.call', tool: 'create_element', input: { category: '不存在的分类', name: '失败样本' }, expect: { ok: true } },
    ] }));
    await expect(seedDevelopmentDatabase({ databasePath, scenarioPath, preset: 'lite' })).rejects.toThrow('Scenario');
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try { expect(count(database, 'SELECT count(*) AS n FROM project')).toBe(0); }
    finally { database.close(); }
    expect(readdirSync(directory).some(name => name.includes('.seed-'))).toBe(false);
    writeFileSync(scenarioPath, JSON.stringify({ schemaVersion: 1, name: 'retry', steps: [] }));
    await expect(seedDevelopmentDatabase({ databasePath, scenarioPath, preset: 'lite' })).resolves.toMatchObject({ seeded: true });
  });
});
