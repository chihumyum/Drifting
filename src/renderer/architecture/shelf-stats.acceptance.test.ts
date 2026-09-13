import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
const root = fileURLToPath(new URL('../../..', import.meta.url));
function validate(mutation = '') {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { validateShelfStatsReport } from './scripts/renderer-shelf-stats-contract.mjs';
    const report = JSON.parse(fs.readFileSync('docs/renderer-performance/acceptance/f2-shelf-stats.json', 'utf8'));
    ${mutation}
    validateShelfStatsReport(report);
  `], { cwd: root, encoding: 'utf8' });
}
describe('shelf aggregate evidence', () => {
  it('accepts the captured historical comparison', () => { const result = validate(); expect(result.status, result.stderr).toBe(0); });
  it.each([
    ['different stats', 'report.profiles[0].current[0].stats.words++;'],
    ['inventory transfer', 'report.profiles[1].current[0].returnedRows = 1000;'],
    ['node-sized parameters', 'report.profiles[1].current[0].maxParameters = 1000;'],
    ['extra query', 'report.profiles[0].current[0].queries++;'],
    ['missing repetition', 'report.profiles[0].baseline.pop();'],
    ['missing large project', 'report.profiles.pop();'],
    ['invalid timing', 'report.profiles[0].current[0].elapsedMs = -1;'],
    ['failed integration', 'report.tests[0].status = "failed";'],
    ['foreign key failure', 'report.fixture.foreignKeys = "failed";'],
    ['native overclaim', 'report.acceptance.native = "passed";'],
    ['startup overclaim', 'report.acceptance.startupImprovement = "passed";'],
  ])('rejects %s', (_label, mutation) => expect(validate(mutation).status).not.toBe(0));
});
