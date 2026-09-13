import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

type Evidence = {
  status: string;
  reads: { samples: { libraryBodyRows: number; queries: number; serializedBytes: number }[] }[];
  acceptance: { nativeRenderer: string; powerLoss: string };
  cases: { kill: { libraryRead: string }; restarts: { projectionHash: string }[] }[];
};
function validate(kind: 'reads' | 'recovery', mutate: (report: Evidence) => void) {
  const directory = mkdtempSync(path.join(tmpdir(), 'drifting-library-contract-'));
  try {
    const report = JSON.parse(readFileSync(`docs/renderer-performance/acceptance/f6-library-${kind}.json`, 'utf8')) as Evidence;
    mutate(report);
    const file = path.join(directory, 'report.json'); writeFileSync(file, JSON.stringify(report));
    const runner = kind === 'reads' ? 'scripts/run-workspace-library-acceptance.mjs' : 'scripts/run-workspace-projection-recovery.mjs';
    return spawnSync(process.execPath, [runner, '--check', '--historical', ...(kind === 'recovery' ? ['--library'] : []), `--output=${file}`], { encoding: 'utf8' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
it.each(['reads', 'recovery'] as const)('accepts historical %s without asserting current-source performance', kind => {
  const result = validate(kind, () => undefined); expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('current source was not asserted');
});
it.each([
  ['missing profile', (r: Evidence) => { r.reads.pop(); }],
  ['full body scan', (r: Evidence) => { r.reads[1].samples[0].libraryBodyRows = 1025; }],
  ['extra queries', (r: Evidence) => { r.reads[1].samples[0].queries = 128; }],
  ['full body transfer', (r: Evidence) => { r.reads[1].samples[0].serializedBytes = 100000000; }],
  ['native claim', (r: Evidence) => { r.acceptance.nativeRenderer = 'passed'; }],
])('rejects %s in library read evidence', (_name, mutate) => expect(validate('reads', mutate).status).not.toBe(0));
it.each([
  ['missing crash case', (r: Evidence) => { r.cases.pop(); }],
  ['full read at scoped crash boundary', (r: Evidence) => { r.cases.find(c => c.kill.libraryRead === 'changed')!.kill.libraryRead = 'all'; }],
  ['disagreeing restarts', (r: Evidence) => { r.cases[0].restarts[0].projectionHash = 'a'.repeat(64); }],
  ['power loss claim', (r: Evidence) => { r.acceptance.powerLoss = 'passed'; }],
])('rejects %s in library recovery evidence', (_name, mutate) => expect(validate('recovery', mutate).status).not.toBe(0));
