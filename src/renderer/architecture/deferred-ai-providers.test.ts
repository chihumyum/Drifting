import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

type Report = {
  after: { source: { fingerprint: string }; initialJsBytes: number; initial: { evaluated: string[] }; checks: Record<string, boolean>; moduleRequests: { url: string }[]; chunks: { targets: string[]; imports: string[] }[] };
  adapters: { before: string; after: string }[];
  acceptance: { nativeOrDevice: string; liveProvider: string };
};
function check(mutate: (report: Report) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), 'drifting-ai-module-contract-'));
  try {
    const report = JSON.parse(readFileSync('docs/renderer-performance/acceptance/f7-ai-providers.json', 'utf8')) as Report;
    mutate(report); const file = path.join(dir, 'report.json'); writeFileSync(file, JSON.stringify(report));
    return spawnSync(process.execPath, ['scripts/run-renderer-deferred-ai.mjs', '--check', '--historical', `--output=${file}`], { encoding: 'utf8' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
it('validates historical provider evidence without claiming the current source was measured', () => {
  const result = check(() => undefined); expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain('current source was not asserted');
});
it.each([
  ['eager SDK', (r: Report) => { r.after.initial.evaluated.push('google'); }],
  ['missing cancel check', (r: Report) => { delete r.after.checks.openaiCancelIsolated; }],
  ['failed offline guard', (r: Report) => { r.after.checks.offlineDuringGoogleLoad = false; }],
  ['same failed URL retry', (r: Report) => { r.after.moduleRequests[1].url = r.after.moduleRequests[0].url; }],
  ['unretryable cold dependency', (r: Report) => { r.after.chunks.find(chunk => chunk.targets.includes('openai'))!.imports.push('cold-untracked-sdk.js'); }],
  ['changed adapter behavior', (r: Report) => { r.adapters[0].after = 'a'.repeat(64); }],
  ['native claim', (r: Report) => { r.acceptance.nativeOrDevice = 'passed'; }],
  ['live provider claim', (r: Report) => { r.acceptance.liveProvider = 'passed'; }],
])('rejects %s in deferred provider evidence', (_name, mutate) => expect(check(mutate).status).not.toBe(0));
