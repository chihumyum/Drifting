import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

type Report = {
  cases: { cancelKill: { observed: { transactionIds: string[]; committedTransactionIds: string[] }; exit: { code: number | null; signal: string | null } };
    restarts: { databaseHash: string; pending: unknown; toolCalls: number }[] }[];
  baseline: { workerSha256: string };
};
const fixture = () => JSON.parse(readFileSync('docs/renderer-performance/acceptance/f4-control-recovery.json', 'utf8')) as Report;
function validate(report: Report) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { readFileSync } from 'node:fs';
    import { validateControlRecovery } from './scripts/agent-control-recovery-contract.mjs';
    validateControlRecovery(JSON.parse(readFileSync(0, 'utf8')));
  `], { cwd: process.cwd(), encoding: 'utf8', input: JSON.stringify(report) });
  if (result.error) throw result.error; return result;
}
it('accepts the complete control recovery matrix without treating its historical source as current', () => {
  const result = validate(fixture()); expect(result.stderr).toBe(''); expect(result.status).toBe(0);
});
const mutations: [string, (report: Report) => void][] = [
  ['missing boundary', report => { report.cases.pop(); }],
  ['normal exit presented as SIGKILL', report => { report.cases[0].cancelKill.exit = { code: 0, signal: null }; }],
  ['separate cancellation transactions', report => { report.cases[2].cancelKill.observed.transactionIds[1] = 'foreign-transaction'; }],
  ['premature commit', report => { report.cases[0].cancelKill.observed.committedTransactionIds = report.cases[0].cancelKill.observed.transactionIds; }],
  ['partial durable cancellation', report => { for (const restart of report.cases[0].restarts) restart.databaseHash = '0'.repeat(64); }],
  ['lost recovered control', report => { for (const restart of report.cases[0].restarts) restart.pending = null; }],
  ['tool replay on restart', report => { for (const restart of report.cases[0].restarts) restart.toolCalls = 1; }],
  ['missing independent restart', report => { report.cases[0].restarts.pop(); }],
  ['different baseline worker', report => { report.baseline.workerSha256 = '0'.repeat(64); }],
];
it.each(mutations)('rejects %s', (_name, mutate) => { const report = fixture(); mutate(report); expect(validate(report).status).not.toBe(0); });
