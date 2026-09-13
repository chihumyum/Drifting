import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

type Evidence = {
  reads: { samples: { payloadRows: number; queries: number; rows: number; serializedBytes: number }[] }[];
  baseline: { testSha256: string };
  acceptance: { nativeRenderer: string; powerLoss: string };
  cases: { kill: { commentRead: string; commentActionRead: string }; restarts: { projectionHash: string }[] }[];
};
function validate(kind: 'reads' | 'recovery', mutate: (report: Evidence) => void) {
  const directory = mkdtempSync(path.join(tmpdir(), 'drifting-comment-contract-'));
  try {
    const report = JSON.parse(readFileSync(`docs/renderer-performance/acceptance/f6-comment-${kind}.json`, 'utf8')) as Evidence;
    mutate(report);
    const file = path.join(directory, 'report.json'); writeFileSync(file, JSON.stringify(report));
    const runner = kind === 'reads' ? 'scripts/run-workspace-comment-acceptance.mjs' : 'scripts/run-workspace-projection-recovery.mjs';
    return spawnSync(process.execPath, [runner, '--check', '--historical', ...(kind === 'recovery' ? ['--comments'] : []), `--output=${file}`], { encoding: 'utf8' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
it.each(['reads', 'recovery'] as const)('accepts historical comment %s without asserting current-source performance', kind => {
  const result = validate(kind, () => undefined); expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('current source was not asserted');
});
it.each([
  ['missing action profile', (r: Evidence) => { r.reads.pop(); }],
  ['full payload read', (r: Evidence) => { r.reads[1].samples[0].payloadRows = 1025; }],
  ['additional order query', (r: Evidence) => { r.reads[1].samples[0].queries = 5; }],
  ['full ID transfer', (r: Evidence) => { r.reads[1].samples[0].rows = 1029; }],
  ['full payload transfer', (r: Evidence) => { r.reads[1].samples[0].serializedBytes = 100000000; }],
  ['unmatched probe', (r: Evidence) => { r.baseline.testSha256 = 'a'.repeat(64); }],
  ['native claim', (r: Evidence) => { r.acceptance.nativeRenderer = 'passed'; }],
])('rejects %s in comment read evidence', (_name, mutate) => expect(validate('reads', mutate).status).not.toBe(0));
it.each([
  ['missing crash case', (r: Evidence) => { r.cases.pop(); }],
  ['full comment read at scoped boundary', (r: Evidence) => { r.cases.find(c => c.kill.commentRead === 'changed')!.kill.commentRead = 'all'; }],
  ['full action read at scoped boundary', (r: Evidence) => { r.cases.find(c => c.kill.commentActionRead === 'changed')!.kill.commentActionRead = 'all'; }],
  ['disagreeing restarts', (r: Evidence) => { r.cases[0].restarts[0].projectionHash = 'a'.repeat(64); }],
  ['power loss claim', (r: Evidence) => { r.acceptance.powerLoss = 'passed'; }],
])('rejects %s in comment recovery evidence', (_name, mutate) => expect(validate('recovery', mutate).status).not.toBe(0));
