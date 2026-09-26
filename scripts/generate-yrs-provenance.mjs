import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const root = 'vendor/yrs';
const path = `${root}/UPSTREAM.json`;
const source = JSON.parse(readFileSync(path));
const patches = [
  ['src/store.rs', 'Carry ItemSlice.start through each redone link, preserving relative-position offsets after undo'],
  ['src/undo.rs', 'Restore the optional child-before-parent deletion filter for synchronous and asynchronous undo/redo, exposing read-only parent context'],
  ['src/transaction.rs', 'Replay pending updates when sparse-hole coverage changes without advancing the largest client clock'],
  ['src/sync/awareness.rs', 'Test-only: inject a fixed clock into awareness_summary so peer-local receipt timestamps do not make unchanged assertions timing-dependent'],
];
const hash = file => createHash('sha256').update(readFileSync(`${root}/${file}`)).digest('hex');
for (const [file, expected] of Object.entries(source.originalFiles)) {
  if (!patches.some(([patched]) => patched === file)) assert.equal(hash(file), expected, `Unrecorded upstream modification: ${file}`);
}
source.patches = patches.map(([path, purpose]) => ({ path, purpose, sha256: hash(path) }));
const generated = `${JSON.stringify(source, null, 2)}\n`;
if (process.argv.includes('--check')) assert.equal(readFileSync(path, 'utf8'), generated);
else writeFileSync(path, generated);
console.log('Yrs provenance: three correctness patches and one test-only clock patch; all other upstream files match.');
