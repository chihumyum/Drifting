import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../..', import.meta.url));
function validate(mutation = '') {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { validateTopTabsAcceptance } from './scripts/renderer-top-tabs-contract.mjs';
    const report = JSON.parse(fs.readFileSync('docs/renderer-performance/acceptance/f2-top-tabs.json', 'utf8'));
    ${mutation}
    validateTopTabsAcceptance(report);
  `], { cwd: root, encoding: 'utf8' });
}
describe('top-tab presentation measured evidence', () => {
  it('accepts the recorded baseline/current comparison', () => {
    const result = validate(); expect(result.status, result.stdout + result.stderr).toBe(0);
  });
  it.each([
    ['missing scale', 'report.browser.profiles.pop();'],
    ['metric renders', 'report.browser.profiles[8].metrics.renders = 100;'],
    ['hidden linear work', 'report.browser.profiles[8].metrics.indexRows = 0;'],
    ['repeated searches', 'report.browser.profiles[8].metrics.arrayVisits = 1;'],
    ['body measurements', 'report.browser.profiles[8].unrelatedBodies.measurements = 20;'],
    ['color measurement', 'report.browser.profiles[8].colorChange.measurements = 20;'],
    ['missing rename invalidation', 'report.browser.profiles[8].rename.measurements = 0;'],
    ['generation reuse', 'report.browser.profiles[8].generationChange.projectedLeaves = 0;'],
    ['incorrect width', 'report.browser.profiles[8].initialWidths[0] += 1;'],
    ['stale project data', 'report.browser.profiles[8].checks.foreignHidden = false;'],
    ['missing split check', 'delete report.browser.profiles[8].checks.splitLabels;'],
    ['failed reorder', 'report.browser.profiles[8].checks.reorderWorks = false;'],
    ['unmounted work', 'report.browser.profiles[8].unmounted.projectedLeaves = 20;'],
    ['substituted baseline', 'report.baseline.browser = structuredClone(report.browser);'],
    ['false device claim', 'report.acceptance.deviceBudget = "passed";'],
  ])('rejects %s', (_label, mutation) => expect(validate(mutation).status).not.toBe(0));
});
