import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

type Report = { after: { profiles: { fixtureSha256: string; work: { arrays: number; comparisons: number; leaves: number }; checks: Record<string, boolean> }[] }; acceptance: { nativeAndPhysical: string; fullAppBudget: string } };
function check(mutate: (report: Report) => void) {
  const directory = mkdtempSync(path.join(tmpdir(), 'drifting-tree-display-contract-'));
  try {
    const report = JSON.parse(readFileSync('docs/renderer-performance/acceptance/f4-tree-display.json', 'utf8')) as Report;
    mutate(report); const file = path.join(directory, 'report.json'); writeFileSync(file, JSON.stringify(report));
    return spawnSync(process.execPath, ['scripts/run-renderer-transcript-display.mjs', '--check', '--historical', `--output=${file}`], { encoding: 'utf8' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
it('validates historical tree display evidence without claiming current-source performance', () => {
  const result = check(() => undefined); expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain('current source was not asserted');
});
it.each([
  ['full arrays during display', (r: Report) => { r.after.profiles[0].work.arrays = 20; }],
  ['full history identity checks', (r: Report) => { r.after.profiles[2].work.comparisons = 200020; }],
  ['omitted leaf traversal cost', (r: Report) => { r.after.profiles[2].work.leaves = 0; }],
  ['lost selection', (r: Report) => { r.after.profiles[0].checks.historyDomAndSelection = false; }],
  ['different fixture', (r: Report) => { r.after.profiles[0].fixtureSha256 = 'a'.repeat(64); }],
  ['missing mobile profile', (r: Report) => { r.after.profiles.pop(); }],
  ['native claim', (r: Report) => { r.acceptance.nativeAndPhysical = 'passed'; }],
  ['whole-app budget claim', (r: Report) => { r.acceptance.fullAppBudget = 'passed'; }],
])('rejects %s in tree display evidence', (_name, mutate) => expect(check(mutate).status).not.toBe(0));
