// Runs the two-way Markdown folder tests and records them as acceptance
// evidence (docs/markdown-mirror.md). `--check` only verifies that the report
// still matches the current source.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const reportPath = 'docs/agent-runtime/acceptance/markdown-mirror.json';
const tests = [
  'src/renderer/services/markdown-mirror/authored-file.test.ts',
  'src/renderer/services/markdown-mirror/reconcile-yjs.test.ts',
  'src/renderer/services/markdown-mirror/ingest.integration.test.ts',
  'src/renderer/services/markdown-mirror/mirror.integration.test.ts',
  'src/renderer/services/markdown-projection.service.test.ts',
];
const files = [
  'scripts/run-markdown-mirror-acceptance.mjs',
  'drizzle/0013_markdown_mirror_ledger.sql',
  'src-tauri/src/markdown_projection.rs',
  'src/renderer/services/markdown-mirror/authored-file.ts',
  'src/renderer/services/markdown-mirror/reconcile-yjs.ts',
  'src/renderer/services/markdown-mirror/ingest.ts',
  'src/renderer/services/markdown-mirror/mirror.ts',
  'src/renderer/services/markdown-mirror/overlap-todo.ts',
  'src/renderer/services/markdown-projection.service.ts',
  'src/renderer/sqlite-repo/markdown-mirror-repo.ts',
  'src/renderer/lib/agent/runtime/workspace-prose-file.ts',
  ...tests,
];
const fingerprint = () => {
  const hash = createHash('sha256');
  for (const file of files) hash.update(file).update('\0').update(readFileSync(file));
  return hash.digest('hex');
};

if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.equal(report.status, 'passed');
  assert.equal(report.sourceSha256, fingerprint());
  console.log('Markdown folder two-way evidence matches current source.');
} else {
  const before = fingerprint();
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-markdown-mirror-'));
  try {
    const output = path.join(temporary, 'vitest.json');
    execFileSync('pnpm', ['exec', 'vitest', 'run', ...tests, '--reporter=json', `--outputFile=${output}`], { stdio: 'inherit' });
    const vitest = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(vitest.success, true);
    const renderer = vitest.testResults.flatMap(file => file.assertionResults.map(result => {
      assert.equal(result.status, 'passed', `${result.fullName} ${result.status}`);
      return `${path.relative(root, file.name)} › ${result.fullName}`;
    }));
    const cargo = execFileSync('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', 'markdown_projection::'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    const native = [...cargo.matchAll(/^test (markdown_projection::\S+) \.\.\. ok$/gmu)].map(match => match[1]).sort();
    assert.match(cargo, /test result: ok\./u);
    assert.ok(native.length > 0);
    assert.equal(before, fingerprint());
    writeFileSync(reportPath, JSON.stringify({
      kind: 'markdown-folder-two-way',
      generatedAt: new Date().toISOString(),
      sourceSha256: before,
      status: 'passed',
      synthetic: true,
      checks: { renderer, native },
      boundaries: {
        storage: 'real SQLite with every product migration; Yjs merges between independent documents',
        filesystem: 'native writer and reader in temporary directories; the renderer tests use an in-memory folder',
        app: 'polling and the settings panel are covered by unit tests, not a running app',
      },
    }, null, 2) + '\n');
    console.log(`Markdown folder two-way: ${renderer.length} renderer and ${native.length} native checks passed.`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
