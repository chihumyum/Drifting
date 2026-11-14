import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

// 2026-11-14: a Windows author's library failed to open on five launches in a
// row. The report said only "could not open", the shelf drew over a closed
// database, and the update check never ran because it waits for the library.
describe('a library that cannot be opened', () => {
  it('replaces the app with the failure screen, whatever stopped the open', () => {
    const app = source('../App.tsx');
    const branch = app.slice(app.indexOf('if (databaseFailure) {'), app.indexOf('{seaEnabled && <CharSea />}'));
    expect(branch).toContain('<DatabaseRecoveryBoundary failure={databaseFailure} />');
    // Feedback stays reachable; nothing that reads the library is mounted.
    expect(branch).toContain('<FeedbackDialogHost />');
    expect(branch).not.toContain('<AppRoutes />');
    expect(app).not.toContain('databaseFailure?.recoverySessionId');
  });

  it('says why, and offers a retry, the data folder and feedback when there is nothing to restore', () => {
    const boundary = source('./components/DatabaseRecoveryBoundary.tsx');
    expect(boundary).toContain("t('databaseRecovery.reason')");
    expect(boundary).toContain('{failure.detail}');
    expect(boundary).toContain('window.location.reload()');
    expect(boundary).toContain('databasePlatform.openDatabaseDirectory()');
    expect(boundary).toContain('useFeedbackDialogStore.getState().show()');
    // The report names the step in its code and carries what the step said.
    expect(boundary).toContain('code: `database-open-failed:${failure.code}`');
    expect(boundary).toContain('cause: databaseOpenFailureCause(failure.detail)');
  });

  it('looks for a newer release from the failure screen and installs it from there', () => {
    const boundary = source('./components/DatabaseRecoveryBoundary.tsx');
    expect(boundary).toContain('void UpdateService.check({ manual: true });');
    expect(boundary).toContain('UpdateService.install()');
  });

  it('does not let the session check fail a second time as an unhandled rejection', () => {
    const routes = source('./AppRoutes.tsx');
    expect(routes.match(/exceptFailedOpen/g)).toHaveLength(3);
    expect(routes).toContain('checkSession().catch(exceptFailedOpen).finally(() => setIsChecking(false))');
  });
});
