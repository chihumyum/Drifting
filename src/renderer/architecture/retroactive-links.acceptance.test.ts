import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

type Evidence = { source: { fingerprint: string; baselineFunctionHash: string }; behavior: { passed: boolean }[]; nativeAcceptance: boolean;
  profiles: { current: { counters: { regexConstructions: number; markCreations: number }; resultHash: string; samplesMs: number[] } }[] };
function validate(mutate: (report: Evidence) => void, historical = true) {
  const directory = mkdtempSync(path.join(tmpdir(), 'drifting-retroactive-contract-'));
  try {
    const report = JSON.parse(readFileSync('docs/renderer-performance/acceptance/f3-link-matching.json', 'utf8')) as Evidence;
    mutate(report); const file = path.join(directory, 'report.json'); writeFileSync(file, JSON.stringify(report));
    return spawnSync(process.execPath, ['--conditions=import', '--import=tsx', 'scripts/measure-retroactive-links.ts', '--check', ...(historical ? ['--historical'] : []), `--report=${file}`], { encoding: 'utf8' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
it('validates historical matching evidence without asserting current performance', () => {
  const result = validate(() => undefined); expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('current source was not asserted');
});
it.each([
  ['missing scale', (r: Evidence) => { r.profiles.pop(); }],
  ['repeated regex allocation', (r: Evidence) => { r.profiles[8].current.counters.regexConstructions = 80000; }],
  ['per-match mark allocation', (r: Evidence) => { r.profiles[8].current.counters.markCreations = 10000; }],
  ['different document or steps', (r: Evidence) => { r.profiles[0].current.resultHash = '0'.repeat(64); }],
  ['failed semantics', (r: Evidence) => { r.behavior[0].passed = false; }],
  ['missing sample', (r: Evidence) => { r.profiles[0].current.samplesMs.pop(); }],
  ['different historical function', (r: Evidence) => { r.source.baselineFunctionHash = '0'.repeat(64); }],
  ['native claim', (r: Evidence) => { r.nativeAcceptance = true; }],
])('rejects %s in matching evidence', (_name, mutate) => expect(validate(mutate).status).not.toBe(0));
it('requires current source by default even when historical checks pass', () => {
  const mutate = (r: Evidence) => { r.source.fingerprint = '0'.repeat(64); };
  expect(validate(mutate).status).toBe(0);
  const result = validate(mutate, false); expect(result.status).not.toBe(0); expect(result.stderr).toContain('report source differs from current source');
});
