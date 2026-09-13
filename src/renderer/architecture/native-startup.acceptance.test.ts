import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
const root = fileURLToPath(new URL('../../..', import.meta.url));
function validate(mutation = '') {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { validateStartupReport } from './scripts/renderer-startup-contract.mjs';
    const report = JSON.parse(fs.readFileSync('docs/renderer-performance/acceptance/f0-native-startup.json', 'utf8'));
    ${mutation}
    validateStartupReport(report);
  `], { cwd: root, encoding: 'utf8' });
}
describe('repeated native startup evidence', () => {
  it('accepts the measured baseline', () => { const result = validate(); expect(result.status, result.stderr).toBe(0); });
  it.each([
    ['missing repetition', 'report.runs.pop();'],
    ['wrong long document', 'report.runs[0].editorTrials[0].characters = 5000;'],
    ['changed prose', 'report.runs[0].proseUnchanged = false;'],
    ['hidden window', 'report.runs[0].visible = false;'],
    ['reused database', 'report.fixture.freshCopyPerLaunch = false;'],
    ['missing ready stage', 'report.runs[0].marks.pop();'],
    ['unsupported exit claim', 'report.runs[0].nativeExitCode = 0;'],
    ['missing shutdown', 'report.runs[0].nativeProcessExited = false;'],
    ['invalid metric', 'report.runs[0].metrics.bootstrapMs = -1;'],
    ['fabricated percentile', 'report.summary.first50kOpenMs.p95 = 1;'],
    ['warmup in statistics', 'report.warmupRuns = 0;'],
    ['wrong build', 'report.artifact.build = "packaged-debug";'],
    ['M1 overclaim', 'report.acceptance.fixedM1Budget = "passed";'],
    ['cold cache overclaim', 'report.acceptance.coldFilesystem = "controlled";'],
  ])('rejects %s', (_label, mutation) => expect(validate(mutation).status).not.toBe(0));
});
