import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
const root = fileURLToPath(new URL('../../..', import.meta.url));
function validate(mutation = '') {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { validateProjectRoutes } from './scripts/renderer-project-routes-contract.mjs';
    const report = JSON.parse(fs.readFileSync('docs/renderer-performance/acceptance/f7-project-routes.json', 'utf8'));
    ${mutation}
    validateProjectRoutes(report);
  `], { cwd: root, encoding: 'utf8' });
}
it('accepts measured production loading and synthetic route ownership', () => {
  const result = validate(); expect(result.status, result.stdout + result.stderr).toBe(0);
});
it.each([
  ['eager route', 'report.after.initial.evaluated.push("desktopShell")'],
  ['unowned feature dependency', 'report.after.chunks.find(c => c.file.includes("settings-panels-")).imports.push("cold.js")'],
  ['missing CSS recovery', 'report.after.failures.pop()'],
  ['workspace mounted before retry', 'report.after.failures[0].workspacesBeforeRetry = 1'],
  ['stale owner', 'report.after.checks.lateProjectOwner = false'],
  ['draft replacement', 'report.after.checks.draftContinuity = false'],
  ['missing standalone settings', 'delete report.after.checks.standaloneSettings'],
  ['device overclaim', 'report.acceptance.nativeOrDevice = "passed"'],
])('rejects %s', (_name, mutation) => expect(validate(mutation).status).not.toBe(0));
