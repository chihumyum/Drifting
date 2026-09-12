import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as Y from 'yjs';
import { inspectNativeFixture, nativeEditMarker } from '../../scripts/renderer-native-db';

const root = fileURLToPath(new URL('../..', import.meta.url));

describe('native renderer acceptance data boundary', () => {
  it('refuses an existing directory before opening or migrating its database', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'drifting-fixture-refusal-'));
    try {
      const file = path.join(directory, 'drifting-library.db');
      const sentinel = Buffer.from('This file must never be opened as a writable database.');
      writeFileSync(file, sentinel);
      const result = spawnSync(process.execPath, ['--conditions=import', '--import=tsx', 'scripts/renderer-native-fixture.ts', directory], { cwd: root, encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('EEXIST');
      expect(readFileSync(file)).toEqual(sentinel);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('independently replays snapshot plus updates, ignoring a stale prose cache without writing the file', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'drifting-fixture-inspection-'));
    const file = path.join(directory, 'synthetic.db');
    const db = new DatabaseSync(file);
    const doc = new Y.Doc();
    try {
      db.exec(`
        CREATE TABLE book_node (id TEXT, project_id TEXT, title TEXT, deleted_at TEXT, content_json TEXT);
        CREATE TABLE element (id TEXT, project_id TEXT, name TEXT, deleted_at TEXT);
        CREATE TABLE entity_relation (project_id TEXT, from_kind TEXT, from_id TEXT, to_kind TEXT, to_id TEXT, relation_type_id TEXT);
        CREATE TABLE yjs_snapshots (document_id TEXT, state_blob BLOB);
        CREATE TABLE yjs_updates (id INTEGER PRIMARY KEY, document_id TEXT, update_blob BLOB);
      `);
      db.prepare('INSERT INTO book_node VALUES (?, ?, ?, NULL, ?)').run('chapter', 'project', 'Synthetic', '{"text":"stale cache"}');
      const paragraph = new Y.XmlElement('paragraph');
      const text = new Y.XmlText('Synthetic authoritative prose');
      paragraph.insert(0, [text]); doc.getXmlFragment('default').insert(0, [paragraph]);
      db.prepare('INSERT INTO yjs_snapshots VALUES (?, ?)').run('node-content:chapter', Y.encodeStateAsUpdate(doc));
      const vector = Y.encodeStateVector(doc);
      text.insert(text.length, nativeEditMarker);
      db.prepare('INSERT INTO yjs_updates VALUES (?, ?, ?)').run(1, 'node-content:chapter', Y.encodeStateAsUpdate(doc, vector));
      db.close();
      const bytes = readFileSync(file);
      const observed = inspectNativeFixture(file);
      expect(observed.chapters).toHaveLength(1);
      expect(observed.chapters[0]).toMatchObject({ characters: 'Synthetic authoritative prose'.length + nativeEditMarker.length, hasSavedMarker: true });
      expect(readFileSync(file)).toEqual(bytes);
      expect(inspectNativeFixture(file)).toEqual(observed);
    } finally { if (db.isOpen) db.close(); doc.destroy(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('keeps acceptance imports out of the normal renderer and native credential source', () => {
    const entry = readFileSync(path.join(root, 'src/renderer/main.tsx'), 'utf8');
    expect(entry).not.toMatch(/renderer-native-ui|__nativeAcceptance/);
    const secureStorage = readFileSync(path.join(root, 'src-tauri/src/secure_storage.rs'), 'utf8');
    expect(secureStorage).toContain('const KEYCHAIN_SERVICE: &str = "Drifting";');
    expect(secureStorage).not.toContain('RendererAcceptance');
    execFileSync(process.execPath, ['--check', 'scripts/run-renderer-native.mjs'], { cwd: root });
  });
});
