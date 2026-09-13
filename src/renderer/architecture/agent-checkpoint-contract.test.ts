import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
type Report = {
  measurements: { lists: { rows: number; plan: string[] }[] }[];
  crashes: { kill: { observed: { compacted: number[]; committed: boolean }; exit: { code: number | null; signal: string | null } };
    restarts: { databaseHash: string; fullOrdinals: number[] }[] }[];
  native: { tests: string[] };
  baseline: { workerSha256: string };
};
const fixture = () => JSON.parse(readFileSync('docs/renderer-performance/acceptance/f4-checkpoint-retention.json', 'utf8')) as Report;
function validate(report: Report) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { readFileSync } from 'node:fs';
    import { validateCheckpointAcceptance } from './scripts/agent-checkpoint-contract.mjs';
    validateCheckpointAcceptance(JSON.parse(readFileSync(0, 'utf8')));
  `], { cwd: process.cwd(), encoding: 'utf8', input: JSON.stringify(report) });
  if (result.error) throw result.error; return result;
}
it('accepts the complete checkpoint evidence without inferring current source or native UI acceptance', () => {
  const result = validate(fixture()); expect(result.stderr).toBe(''); expect(result.status).toBe(0);
});
const mutations: [string, (report: Report) => void][] = [
  ['full historical row loading', report => { report.measurements[2].lists[0].rows = 5000; }],
  ['a query plan without the partial index', report => { report.measurements[0].lists[0].plan = ['SCAN agent_runtime_checkpoint']; }],
  ['normal exit presented as SIGKILL', report => { report.crashes[0].kill.exit = { code: 0, signal: null }; }],
  ['a missing compaction boundary', report => { report.crashes.splice(4, 1); }],
  ['an unwitnessed compaction', report => { report.crashes[4].kill.observed.compacted = []; }],
  ['a premature transaction commit', report => { report.crashes[4].kill.observed.committed = true; }],
  ['partial durable rows after pre-commit kill', report => { for (const restart of report.crashes[0].restarts) restart.databaseHash = '0'.repeat(64); }],
  ['a lost older anchor', report => { for (const restart of report.crashes[11].restarts) restart.fullOrdinals = [6]; }],
  ['a missing independent restart', report => { report.crashes[0].restarts.pop(); }],
  ['missing native migration preservation', report => { report.native.tests.pop(); }],
  ['different baseline instrumentation', report => { report.baseline.workerSha256 = '0'.repeat(64); }],
];
it.each(mutations)('rejects %s', (_name, mutate) => { const report = fixture(); mutate(report); expect(validate(report).status).not.toBe(0); });
