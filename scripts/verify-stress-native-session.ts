// Read-only checks of synthetic markers authored through the real native UI.
// Never seed or repair data here; a missing marker must fail acceptance.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as Y from 'yjs';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import { countWords, extractProseText } from '../packages/prose-metrics/src/index';

const [profileDirectory, output] = process.argv.slice(2);
assert(profileDirectory && output, 'Usage: node --import=tsx scripts/verify-stress-native-session.ts <profile-directory> <output.json>');
const profile = JSON.parse(readFileSync(path.join(profileDirectory, 'profile.json'), 'utf8'));
const database = new DatabaseSync(path.join(profile.databaseDirectory, 'drifting-library.db'), { readOnly: true });
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
try {
  const checks: Record<string, boolean> = {};
  const bodies: Array<Record<string, unknown>> = [];
  const markers = [
    { key: 'chapter-20k', table: 'book_node', query: "title = '第006章 归岛·失约的船'", prefix: 'node-content', marker: '原生压力验收', cached: 'word_count' },
    { key: 'idea-50k', table: 'book_node', query: "kind = 'drift' AND word_count >= 50000", prefix: 'node-content', marker: '原生五万字验收', cached: 'word_count' },
    { key: 'element-10k', table: 'element', query: "name = '气象站航海日记·16'", prefix: 'element', marker: '原生要素验收' },
    { key: 'material-note', table: 'library_item', query: "title = '笔记01 · 调研'", prefix: 'library-item', marker: '原生素材验收' },
  ];
  for (const item of markers) {
    const live = item.table === 'library_item' ? '' : 'deleted_at IS NULL AND ';
    const row = database.prepare(`SELECT * FROM ${item.table} WHERE ${live}${item.query} LIMIT 1`).get();
    assert(row, `Missing synthetic fixture: ${item.key}`);
    const documentId = `${item.prefix}:${row.id}`;
    const doc = new Y.Doc();
    try {
      const snapshot = database.prepare('SELECT state_blob FROM yjs_snapshots WHERE document_id = ?').get(documentId);
      if (snapshot) Y.applyUpdate(doc, snapshot.state_blob as Uint8Array);
      for (const update of database.prepare('SELECT update_blob FROM yjs_updates WHERE document_id = ? ORDER BY id').all(documentId)) Y.applyUpdate(doc, update.update_blob as Uint8Array);
      const json = yDocToProsemirrorJSON(doc, 'default');
      const text = extractProseText(json);
      const words = countWords(text);
      assert(text.includes(item.marker), `UI write missing from canonical Yjs: ${item.key}`);
      checks[`${item.key}-canonical-marker`] = true;
      if (item.cached) {
        assert.equal(words, row[item.cached], `Stale word cache: ${item.key}`);
        checks[`${item.key}-word-cache`] = true;
      }
      bodies.push({ key: item.key, words, canonicalSha256: sha256(JSON.stringify(json)) });
    } finally { doc.destroy(); }
  }
  const todo = database.prepare("SELECT id FROM comment WHERE kind = 'todo' AND body_json LIKE '%原生验收 TODO%' LIMIT 1").get();
  const comment = database.prepare("SELECT id,target_kind FROM comment WHERE kind = 'note' AND body_json LIKE '%原生验收批注%' LIMIT 1").get();
  assert(todo && comment, 'Native Review writes were not durable');
  checks.reviewMarkers = true;
  const refs = database.prepare('SELECT to_kind FROM entity_relation WHERE from_id = ?').all(comment.id);
  assert(comment.target_kind === 'node' && refs.some(r => r.to_kind === 'element'), 'Comment target and additional association missing');
  checks.commentNodeAndElementRelations = true;
  const edge = database.prepare("SELECT r.from_kind,r.to_kind FROM entity_relation r JOIN entity_relation_type t ON t.id = r.relation_type_id WHERE t.name = '原生验收·情节承接'").get();
  assert(edge?.from_kind === 'node' && edge.to_kind === 'node', 'Graph-authored relation missing');
  checks.graphRelation = true;
  const elementEdge = database.prepare("SELECT r.id FROM entity_relation r JOIN element a ON a.id = r.from_id JOIN element b ON b.id = r.to_id WHERE (a.name = '气象站航海日记·16' AND b.name = '林潮') OR (b.name = '气象站航海日记·16' AND a.name = '林潮')").get();
  assert(elementEdge, 'Element relation missing'); checks.elementRelation = true;
  assert(database.prepare("SELECT id FROM library_item WHERE title = '笔记11 · 已整理 · 原生验收'").get()); checks.materialTitle = true;
  assert(database.prepare("SELECT project_id FROM agent_working_memory WHERE content_md LIKE '%原生重型数据验收%'").get()); checks.agentWorkingMemory = true;
  const integrity = database.prepare('PRAGMA integrity_check').all();
  assert.deepEqual(integrity.map(row => Object.values(row)[0]), ['ok']);
  assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
  checks.sqliteIntegrity = true; checks.foreignKeys = true;
  const log = readFileSync(path.join(profileDirectory, 'logs/renderer-stalls.log'), 'utf8');
  const stalls = log.trim().split('\n').map(line => JSON.parse(line)).filter(row => row.event === 'stall' || row.event === 'stall-recovered').map(row => ({
    event: row.event, at: row.at, nativeSilentMs: row.nativeSilentMs, blocked: row.blocked ?? null,
    rendererBlockedMs: row.renderer?.blockedMs ?? null,
    activities: row.renderer?.activities?.map((activity: { label: string; durationMs: number }) => ({ label: activity.label, durationMs: activity.durationMs })) ?? [],
  }));
  const samples = readdirSync(path.join(profileDirectory, 'logs/stall-samples')).filter(file => file.endsWith('.txt')).map(file => {
    const content = readFileSync(path.join(profileDirectory, 'logs/stall-samples', file), 'utf8');
    return { sha256: sha256(content), signals: { json: /jsonProtoFuncParse|jsonProtoFuncStringify/.test(content),
      layout: /WebCore::.*[Ll]ayout/.test(content), gc: /JSC::Heap::collect|JSC::MarkedBlock::Handle::sweep/.test(content) } };
  });
  const report = { kind: 'native_stress_seed_persistence', generatedAt: new Date().toISOString(), status: 'passed-read-only-reopen-checks',
    scriptSha256: sha256(readFileSync(new URL(import.meta.url))), checks, bodies, watchdog: { logSha256: sha256(log), stalls, samples },
    limits: ['Checks existing synthetic UI writes only; does not author or repair prose.', 'RSS and native stack samples are not JavaScript heap snapshots or proof of a leak.'] };
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ checks: Object.keys(checks).length, canonicalBodies: bodies.length, stalls: stalls.length }));
} finally { database.close(); }
