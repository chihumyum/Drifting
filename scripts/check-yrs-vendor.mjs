import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
const root = 'vendor/yrs';
const source = JSON.parse(readFileSync(`${root}/UPSTREAM.json`));
const patched = new Map(source.patches.map(patch => [patch.path, patch.sha256]));
const hash = file => createHash('sha256').update(readFileSync(`${root}/${file}`)).digest('hex');
assert.equal(source.version, '0.28.0');
assert.equal(source.license, 'MIT');
assert.match(source.archiveSha256, /^[0-9a-f]{64}$/);
for (const [file, original] of Object.entries(source.originalFiles)) {
  assert.equal(hash(file), patched.get(file) ?? original, `Unexpected Yrs source change: ${file}`);
}
const allowed = new Set([...Object.keys(source.originalFiles), 'UPSTREAM.json', 'DRIFTING_PATCHES.md']);
for (const file of readdirSync(root, { recursive: true, withFileTypes: true })) {
  if (file.isDirectory()) continue;
  const relative = `${file.parentPath}/${file.name}`.slice(root.length + 1);
  assert(allowed.has(relative), `Unrecorded vendored file: ${relative}`);
}
assert.equal(patched.size, 5, 'Additional upstream changes need distinct regression and provenance review');
assert(patched.has('src/block_store.rs'));
assert(patched.has('src/store.rs'));
assert(patched.has('src/transaction.rs'));
assert(patched.has('src/undo.rs'));
assert(patched.has('src/sync/awareness.rs'));
console.log(`Yrs ${source.version}: ${Object.keys(source.originalFiles).length} upstream files, three correctness patches across four files and one test-only awareness clock patch, MIT license retained.`);
