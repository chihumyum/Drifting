// Read-only before/after inspection of the isolated synthetic native database.
// UI input is performed separately; no data is authored or repaired here.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
// @ts-expect-error Executable ESM tooling.
import { nativePerformanceSourceFingerprint } from './native-performance-audit-plugin.mjs';
const [profileDirectory, output, mode] = process.argv.slice(2);
assert(profileDirectory && output && ['begin', 'end'].includes(mode!), 'Usage: <profile> <output> begin|end');
const profile = JSON.parse(readFileSync(path.join(profileDirectory, 'profile.json'), 'utf8'));
const database = new DatabaseSync(path.join(profile.databaseDirectory, 'drifting-library.db'), { readOnly: true });
const baseline = path.join(profileDirectory, 'performance-audit/durability-idle-baseline.json');
try {
  const rows = database.prepare('SELECT document_id AS id, updated_at AS updated FROM yjs_snapshots ORDER BY document_id').all() as Array<{ id: string; updated: string }>;
  const fingerprint = nativePerformanceSourceFingerprint(process.cwd()).fingerprint;
  if (mode === 'begin') {
    writeFileSync(baseline, JSON.stringify({ fingerprint, rows }), { mode: 0o600 });
    console.log(JSON.stringify({ capturedSnapshots: rows.length }));
  } else {
    const before = JSON.parse(readFileSync(baseline, 'utf8')) as { fingerprint: string; rows: typeof rows };
    assert.equal(before.fingerprint, fingerprint, 'Source changed during native verification');
    const prior = new Map(before.rows.map(row => [row.id, row.updated]));
    const changed = rows.filter(row => prior.has(row.id) && row.updated !== prior.get(row.id)).length;
    const created = rows.filter(row => !prior.has(row.id)).length;
    assert.equal(rows.length, before.rows.length); assert.equal(changed, 0); assert.equal(created, 0);
    const integrity = database.prepare('PRAGMA integrity_check').get();
    assert.equal(integrity?.integrity_check, 'ok'); assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
    const report = { kind: 'native_idle_yjs_snapshot_reuse', generatedAt: new Date().toISOString(), fingerprint,
      status: 'passed-read-only-checks', snapshotsBefore: before.rows.length, snapshotsAfter: rows.length, changedSnapshots: changed, createdSnapshots: created,
      checks: { sourceMatched: true, noIdleSnapshotRewrite: true, sqliteIntegrity: true, foreignKeys: true },
      scope: 'Before/after SQLite metadata for the isolated synthetic native instance. UI save actions and editor count are recorded separately in the native audit; this does not measure input latency or undo.' };
    mkdirSync(path.dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
  }
} finally { database.close(); }
