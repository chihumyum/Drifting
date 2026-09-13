import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
const root = fileURLToPath(new URL('../../..', import.meta.url));
function validate(mutation = '') {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { validateDeferredMemoEvidence } from './scripts/renderer-deferred-memo-contract.mjs';
    const report = JSON.parse(fs.readFileSync('docs/renderer-performance/acceptance/f7-memo-deferred.json', 'utf8'));
    ${mutation}
    validateDeferredMemoEvidence(report);
  `], { cwd: root, encoding: 'utf8' });
}
describe('deferred memo loading evidence', () => {
  it('accepts the measured entry and mounted UI report', () => {
    const result = validate(); expect(result.status, result.stdout + result.stderr).toBe(0);
  });
  it.each([
    ['eager evaluation', 'report.after.initial.evaluated.push("memo");'],
    ['hidden parsing', 'report.after.initial.parsed.push(report.after.chunks.find(c => c.targets.includes("memo")).file);'],
    ['hidden fetch', 'report.after.initial.requested.push(report.after.chunks.find(c => c.targets.includes("memo")).file);'],
    ['unowned cold dependency', 'report.after.chunks.find(c => c.targets.includes("memo")).imports.push("cold.js");'],
    ['unloaded CSS', 'report.after.chunks.find(c => c.targets.includes("memo")).css.push("cold.css");'],
    ['missing mobile', 'report.ui.pop();'],
    ['stale project', 'report.lateProject.currentDataOnly = false;'],
    ['lost focus', 'report.lateProject.focusTransferred = false;'],
    ['editor replacement', 'report.ui[0].checks.editorPreserved = false;'],
    ['late reopen', 'report.ui[0].checks.canceledOpenStaysClosed = false;'],
    ['missing interaction', 'delete report.ui[1].checks.queryFilters;'],
    ['poisoned preload', 'report.preload.demandRecovered = false;'],
    ['same retry key', 'report.ui[0].requests[1].url = report.ui[0].requests[0].url;'],
    ['native overclaim', 'report.acceptance.native = "passed";'],
    ['startup overclaim', 'report.acceptance.fullAppStartup = "passed";'],
  ])('rejects %s', (_label, mutation) => expect(validate(mutation).status).not.toBe(0));
});
