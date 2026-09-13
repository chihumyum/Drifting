import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../..', import.meta.url));
function validate(mutation = '') {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { validateGlobalSearchAcceptance } from './scripts/renderer-global-search-contract.mjs';
    const report = JSON.parse(fs.readFileSync('docs/renderer-performance/acceptance/f2-global-search.json', 'utf8'));
    ${mutation}
    validateGlobalSearchAcceptance(report);
  `], { cwd: root, encoding: 'utf8' });
}
describe('global search measured evidence contract', () => {
  it('accepts the captured browser and SQLite evidence', () => {
    const result = validate(); expect(result.status, result.stdout + result.stderr).toBe(0);
  });
  it.each([
    ['missing scale', 'report.browser.profiles.pop();'],
    ['hidden read', 'report.browser.profiles[2].hidden.reads = 1;'],
    ['repeated parsing', 'report.browser.profiles[2].repeatedQueries.parses = 5000;'],
    ['stale renamed body', 'report.browser.profiles[0].changedBody.parses = 0;'],
    ['generation cache reuse', 'report.browser.profiles[0].generationChange.parses = 0;'],
    ['late rejected read work', 'report.browser.profiles[1].lateClosedRejection.groups = 1001;'],
    ['late project result', 'report.browser.profiles[1].checks.projectReturnClearsQuery = false;'],
    ['late generation work', 'report.browser.profiles[1].lateGenerationRejection.parses = 1;'],
    ['database replacement', 'report.browser.profiles[1].databaseReplacement.hidesOldResults = false;'],
    ['loading read', 'report.browser.profiles[1].loading.reads = 1;'],
    ['unscoped SQL', 'report.browser.profiles[0].databaseScope.allProjectScoped = false;'],
    ['missing keyboard check', 'delete report.browser.profiles[0].checks.keyboardOpensCurrent;'],
    ['failed SQLite check', 'report.tests[0].status = "failed";'],
    ['baseline substitution', 'report.baseline.browser = structuredClone(report.browser);'],
    ['unmeasured native claim', 'report.acceptance.native = "passed";'],
  ])('rejects %s', (_label, mutation) => {
    expect(validate(mutation).status).not.toBe(0);
  });
});
