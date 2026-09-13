import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, platform, release } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { isProseMetricBasisHash } from '@drifting/prose-metrics';
import * as schema from '../src/renderer/schema/drizzle';
import { createWorkspaceProjectionFixture, WORKSPACE_TEST_NOW } from '../src/renderer/services/workspace-projection.test-support';
import { readProjectStats } from '../src/renderer/sqlite-repo/project-stats-repo';
import { rendererSourceFingerprint } from './renderer-performance-source.mjs';
import { validateShelfStatsReport } from './renderer-shelf-stats-contract.mjs';
import type { ProjectStats } from '../src/renderer/domain/project-summary';
import type { DatabaseQueryResult } from '../src/renderer/platform/database';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'docs/renderer-performance/acceptance/f2-shelf-stats.json');
const harness = ['scripts/measure-shelf-stats.ts', 'scripts/renderer-shelf-stats-contract.mjs'];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const fingerprint = () => hash(rendererSourceFingerprint(root) + harness.map(file => readFileSync(path.join(root, file), 'utf8')).join('\0'));
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

async function main() {
  if (process.argv.includes('--check')) {
    const report = JSON.parse(readFileSync(output, 'utf8'));
    validateShelfStatsReport(report); assert.equal(report.source.fingerprint, fingerprint());
    console.log('Shelf aggregate evidence matches current source and collector.'); return;
  }
  const before = fingerprint();
  const baselineCommit = git('rev-parse', process.argv.find(arg => arg.startsWith('--baseline='))?.slice(11) ?? '880d8963a769fd381b1a44e6a0f0e2668e6fa4d1');
  const baselineSource = git('show', `${baselineCommit}:src/renderer/usecase/useProject.ts`);
  const start = baselineSource.indexOf('async function buildLocalProjectStats(');
  const end = baselineSource.indexOf('\nasync function buildLocalProjectSummaries(', start);
  assert(start > 0 && end > start, 'Baseline function boundary changed');
  const baselineFunction = baselineSource.slice(start, end);
  // Execute the exact historical read path against the same gateway and fixture.
  // Only TypeScript syntax is removed; the baseline algorithm is not recreated.
  const executable = ts.transpileModule(baselineFunction, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None } }).outputText;
  const fixture = await createWorkspaceProjectionFixture();
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-shelf-report-'));
  try {
    const dependencies = { getDb: () => fixture.db, and, eq, inArray, isNull, isProseMetricBasisHash, ...schema };
    const baseline = new Function(...Object.keys(dependencies), `${executable}; return buildLocalProjectStats;`)(...Object.values(dependencies)) as (id: string) => Promise<ProjectStats>;
    const query = fixture.gateway.query.bind(fixture.gateway);
    let reads: { sql: string; parameters: readonly unknown[]; result: DatabaseQueryResult }[] = [];
    fixture.gateway.query = async (...args) => { const result = await query(...args); reads.push({ sql: args[0], parameters: args[1] ?? [], result }); return result; };
    const nodeInsert = fixture.gateway.database.prepare(`insert into book_node (id, project_id, title, kind, word_count, word_count_basis_kind, word_count_basis_hash, position_x, position_y, created_at, updated_at) values (?, 'synthetic-workspace', 'Synthetic', 'chapter', 3, 'seed', ?, 0, 0, ?, ?)`);
    const validHash = `sha256:${'a'.repeat(64)}`;
    fixture.gateway.database.prepare("update book_node set word_count_basis_kind='seed', word_count_basis_hash=?").run(validHash);
    let seeded = 2;
    const profiles = [];
    for (const nodes of [100, 1000, 5000, 40000]) {
      fixture.gateway.database.exec('BEGIN');
      try { for (; seeded < nodes; seeded++) nodeInsert.run(`synthetic-${seeded}`, validHash, WORKSPACE_TEST_NOW, WORKSPACE_TEST_NOW); fixture.gateway.database.exec('COMMIT'); }
      catch (error) { fixture.gateway.database.exec('ROLLBACK'); throw error; }
      const measure = async (reader: (id: string) => Promise<ProjectStats>) => {
        reads = []; const at = performance.now(); const stats = await reader('synthetic-workspace'); const elapsedMs = performance.now() - at;
        return { stats, elapsedMs, queries: reads.length, returnedRows: reads.reduce((n, r) => n + r.result.rows.length, 0), decodedRowJsonBytes: reads.reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r.result.rows)), 0), maxParameters: Math.max(...reads.map(r => r.parameters.length)) };
      };
      const currentReader = (id: string) => readProjectStats(id, fixture.db);
      if (nodes <= 5000) {
        await measure(baseline); await measure(currentReader); // paired warmups excluded
        const oldRuns = []; const currentRuns = [];
        for (let index = 0; index < 5; index++) {
          if (index % 2 === 0) { oldRuns.push(await measure(baseline)); currentRuns.push(await measure(currentReader)); }
          else { currentRuns.push(await measure(currentReader)); oldRuns.push(await measure(baseline)); }
          assert.deepEqual(currentRuns[index].stats, oldRuns[index].stats);
        }
        profiles.push({ nodes, baseline: oldRuns, current: currentRuns });
      } else {
        let baselineFailure: string | null = null;
        try { await measure(baseline); } catch (error) { baselineFailure = String((error as { cause?: Error }).cause?.message ?? (error as Error).name); }
        const current = await measure(currentReader);
        assert.equal(current.stats.nodes, nodes); assert.equal(current.stats.words, (nodes - 2) * 3);
        const aggregate = reads[0];
        const queryPlan = fixture.gateway.database.prepare(`EXPLAIN QUERY PLAN ${aggregate.sql}`).all(...aggregate.parameters as never[]).map(row => row.detail);
        profiles.push({ nodes, baselineFailure, current, queryPlan });
      }
    }
    const suites = ['src/renderer/sqlite-repo/project-stats-repo.integration.test.ts', 'src/renderer/usecase/useProject-summary.test.ts', 'src/renderer/usecase/useProject-shelf.integration.test.ts'];
    const testOutput = path.join(temporary, 'tests.json');
    const run = spawnSync('pnpm', ['exec', 'vitest', 'run', ...suites, '--reporter=json', `--outputFile=${testOutput}`], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const tests = JSON.parse(readFileSync(testOutput, 'utf8')).testResults.flatMap((suite: { assertionResults: { fullName: string; status: string }[] }) => suite.assertionResults.map(test => ({ name: test.fullName, status: test.status })));
    assert.equal(fixture.gateway.database.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    assert.deepEqual(fixture.gateway.database.prepare('PRAGMA foreign_key_check').all(), []);
    const report = { kind: 'shelf_stats_acceptance', schemaVersion: 1, status: 'passed', generatedAt: new Date().toISOString(),
      source: { commit: git('rev-parse', 'HEAD'), fingerprint: before }, baseline: { commit: baselineCommit, functionSha256: hash(baselineFunction) },
      environment: { platform: platform(), release: release(), node: process.version, sqlite: process.versions.sqlite },
      fixture: { synthetic: true, database: 'temporary-file-WAL-FULL-product-migrations', integrity: 'ok', foreignKeys: 'ok' }, profiles, suites, tests,
      acceptance: { native: 'not-run', startupImprovement: 'not-evaluated', deviceBudget: 'not-evaluated' },
      limitations: ['Paired warmup and five alternating runs use Node SQLite and the production Drizzle gateway; elapsed time is descriptive, not native IPC or UI startup timing.', 'Decoded row JSON bytes exclude column metadata and native wire tagging. SQLite still visits project rows to aggregate; constant result size does not imply constant CPU.', 'The 40000-node baseline failure is from this Node SQLite parameter limit. No corresponding native limit is claimed.'] };
    assert.equal(fingerprint(), before, 'Source changed during measurement'); validateShelfStatsReport(report);
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); console.log('Shelf aggregation: paired historical comparison, large-project bound and integration checks passed.');
  } finally { await fixture.close(); rmSync(temporary, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
