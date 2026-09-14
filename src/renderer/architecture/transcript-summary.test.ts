import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

type Report = { after: { profiles: { fixtureSha256: string; usageFooter: string; expectedUsage: { cost: number }; work: { classifiedRows: number; evidenceCandidates: number; summaryBlocks: number }; checks: Record<string, boolean> }[] }; acceptance: { nativeAndPhysical: string; fullAppBudget: string } };
function check(mutate: (report: Report) => void) {
  const directory = mkdtempSync(path.join(tmpdir(), 'drifting-summary-contract-'));
  try {
    const report = JSON.parse(readFileSync('docs/renderer-performance/acceptance/f4-transcript-summary.json', 'utf8')) as Report;
    mutate(report); const file = path.join(directory, 'report.json'); writeFileSync(file, JSON.stringify(report));
    return spawnSync(process.execPath, ['scripts/run-renderer-transcript-summary.mjs', '--check', '--historical', `--output=${file}`], { encoding: 'utf8' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
it('validates recorded summary evidence without asserting current source identity', () => {
  const result = check(() => undefined); expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain('current source was not asserted');
});
it.each([
  ['full history classification', (r: Report) => { r.after.profiles[2].work.classifiedRows = 200020; }],
  ['full mobile evidence scan', (r: Report) => { r.after.profiles[5].work.evidenceCandidates = 200020; }],
  ['omitted block cost', (r: Report) => { r.after.profiles[2].work.summaryBlocks = 0; }],
  ['changed usage arithmetic', (r: Report) => { r.after.profiles[2].expectedUsage.cost += 1; }],
  ['different footer', (r: Report) => { r.after.profiles[2].usageFooter = 'Different'; }],
  ['stale entity target', (r: Report) => { r.after.profiles[5].checks.currentEvidenceTarget = false; }],
  ['different fixture', (r: Report) => { r.after.profiles[0].fixtureSha256 = 'a'.repeat(64); }],
  ['missing mobile profile', (r: Report) => { r.after.profiles.pop(); }],
  ['native claim', (r: Report) => { r.acceptance.nativeAndPhysical = 'passed'; }],
  ['whole-app budget claim', (r: Report) => { r.acceptance.fullAppBudget = 'passed'; }],
])('rejects %s in summary evidence', (_name, mutate) => expect(check(mutate).status).not.toBe(0));
