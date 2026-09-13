import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

type Report = {
  cases: {
    kill: { observed?: unknown; exit: { code: number | null; signal: string | null } };
    restarts: { committed: boolean; checks: string[]; displayHash: string; messageCount: number }[];
  }[];
};
function fixture(): Report {
  return JSON.parse(readFileSync('docs/renderer-performance/acceptance/f4-chat-crash-recovery.json', 'utf8')) as Report;
}
function validate(report: Report) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { readFileSync } from 'node:fs';
    import { validateAgentChatRecovery } from './scripts/agent-chat-recovery-contract.mjs';
    validateAgentChatRecovery(JSON.parse(readFileSync(0, 'utf8')));
  `], { cwd: process.cwd(), encoding: 'utf8', input: JSON.stringify(report) });
  if (result.error) throw result.error;
  return result;
}

it('accepts the complete 24-kill / 48-restart evidence without treating historical fingerprints as current', () => {
  const result = validate(fixture()); expect(result.stderr).toBe(''); expect(result.status).toBe(0);
});

const mutations: [string, (report: Report) => void][] = [
  ['missing case', report => { report.cases.pop(); }],
  ['duplicate case', report => { report.cases[1] = report.cases[0]; }],
  ['normal exit instead of SIGKILL', report => { report.cases[0].kill.exit = { code: 0, signal: null }; }],
  ['unwitnessed commit boundary', report => { delete report.cases[0].kill.observed; }],
  ['missing independent restart', report => { report.cases[0].restarts.pop(); }],
  ['false completed outcome', report => { report.cases[0].restarts[0].committed = true; }],
  ['missing behavior check', report => { report.cases[0].restarts[0].checks.pop(); }],
  ['divergent restart projection', report => { report.cases[0].restarts[1].displayHash = '0'.repeat(64); }],
  ['duplicate final message', report => { report.cases[0].restarts[0].messageCount++; }],
];
it.each(mutations)('rejects %s', (_name, mutate) => {
  const report = fixture(); mutate(report); expect(validate(report).status).not.toBe(0);
});
