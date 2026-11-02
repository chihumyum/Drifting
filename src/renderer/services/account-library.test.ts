import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryOwner, LibraryState } from '../platform';

const mocks = vi.hoisted(() => ({
  tauri: true,
  mobile: false,
  state: null as unknown as LibraryState,
  authority: { mode: 'local', transitionState: 'stable', targetMode: null as string | null, attemptId: null as string | null },
  accounts: [] as Array<{ providerKind: string; accountSubjectId: string }>,
  attempts: [] as Array<{ attemptId: string; targetAccountSubjectId: string | null }>,
  claimOwner: vi.fn(),
  activate: vi.fn(),
  flush: vi.fn(async () => undefined),
}));

vi.mock('../platform', () => ({
  isTauriRuntime: () => mocks.tauri,
  platform: {
    library: {
      state: async () => mocks.state,
      claimOwner: mocks.claimOwner,
      activate: mocks.activate,
    },
  },
}));
vi.mock('../platform/runtime', () => ({ getPlatformRuntime: () => ({ isMobile: mocks.mobile }) }));
vi.mock('../lib/persistence-lifecycle', () => ({ flushLocalApplicationPersistence: mocks.flush }));
vi.mock('../sync/app-authority-repository', () => ({
  createSyncAppAuthorityRepository: () => ({ read: async () => mocks.authority }),
}));
vi.mock('../schema/drizzle', () => ({
  SyncProviderAccountTable: { name: 'accounts' },
  SyncConnectAttemptTable: { name: 'attempts', attemptId: 'attemptId' },
}));
vi.mock('../lib/db', () => ({
  getDb: () => ({
    select: () => ({
      from: (table: { name: string }) => {
        const rows = table.name === 'accounts' ? mocks.accounts : mocks.attempts;
        return Object.assign(Promise.resolve(rows), { limit: async (count: number) => rows.slice(0, count) });
      },
    }),
  }),
}));

import {
  isAccountLibrary,
  needsFirstAccountConnect,
  openLibraryForAccount,
  openLocalLibrary,
  runningLibraryOwner,
  settleRunningLibrary,
} from './account-library';

const local: LibraryOwner = { kind: 'local' };
const account = (subject: string): LibraryOwner => ({ kind: 'account', subject });
function runningOn(owner: LibraryOwner | null, id = 'legacy'): void {
  mocks.state = { activeId: id, activeOwner: owner, libraries: [{ id, owner }] };
}
async function settled(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([promise.then(() => true), new Promise<boolean>((done) => setTimeout(() => done(false), 20))]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tauri = true;
  mocks.mobile = false;
  mocks.authority = { mode: 'local', transitionState: 'stable', targetMode: null, attemptId: null };
  mocks.accounts = [];
  mocks.attempts = [];
  mocks.claimOwner.mockImplementation(async (owner: LibraryOwner) => ({ ...mocks.state, activeOwner: owner }));
  mocks.activate.mockResolvedValue({ libraryId: 'other', restarting: true });
});

describe('account-isolated libraries', () => {
  it('claims an upgraded library for the account its sync authority is bound to', async () => {
    runningOn(null);
    mocks.authority = { mode: 'hosted', transitionState: 'stable', targetMode: null, attemptId: null };
    mocks.accounts = [{ providerKind: 'hosted', accountSubjectId: 'subject-a' }];
    await settleRunningLibrary('subject-a');
    expect(mocks.claimOwner).toHaveBeenCalledWith(account('subject-a'));
    expect(runningLibraryOwner()).toEqual(account('subject-a'));
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it('claims an unbound upgraded library as the local library', async () => {
    runningOn(null);
    await settleRunningLibrary(null);
    expect(mocks.claimOwner).toHaveBeenCalledWith(local);
    expect(isAccountLibrary()).toBe(false);
  });

  it('claims a library still connecting for the account it targets', async () => {
    runningOn(null);
    mocks.authority = { mode: 'local', transitionState: 'connecting', targetMode: 'hosted', attemptId: 'attempt-1' };
    mocks.attempts = [{ attemptId: 'attempt-1', targetAccountSubjectId: 'subject-b' }];
    await settleRunningLibrary(null);
    expect(mocks.claimOwner).toHaveBeenCalledWith(account('subject-b'));
  });

  it('relaunches a signed-in author onto that account library and never resolves', async () => {
    // The smoke: a library disconnected at 14:19 is local while the author is
    // still signed in; the account library restores from the cloud instead.
    runningOn(local);
    const startup = settleRunningLibrary('subject-a');
    expect(await settled(startup)).toBe(false);
    expect(mocks.flush).toHaveBeenCalled();
    expect(mocks.activate).toHaveBeenCalledWith(account('subject-a'));
  });

  it('keeps an account library open for a signed-out author until an explicit choice', async () => {
    runningOn(account('subject-a'));
    await settleRunningLibrary(null);
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it('switches for another account and back to local on sign-out, only on desktop', async () => {
    runningOn(account('subject-a'));
    await settleRunningLibrary(null);
    expect(await settled(openLibraryForAccount('subject-a'))).toBe(true);
    expect(await settled(openLibraryForAccount('subject-b'))).toBe(false);
    expect(mocks.activate).toHaveBeenLastCalledWith(account('subject-b'));
    expect(await settled(openLocalLibrary())).toBe(false);
    expect(mocks.activate).toHaveBeenLastCalledWith(local);

    mocks.activate.mockClear();
    mocks.mobile = true;
    expect(await settled(openLocalLibrary())).toBe(true);
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it('restores only a new account library that has never connected', async () => {
    runningOn(account('subject-a'));
    await settleRunningLibrary('subject-a');
    expect(await needsFirstAccountConnect('subject-a')).toBe(true);
    expect(await needsFirstAccountConnect('subject-b')).toBe(false);
    mocks.attempts = [{ attemptId: 'disconnect-1', targetAccountSubjectId: null }];
    expect(await needsFirstAccountConnect('subject-a')).toBe(false);
    mocks.attempts = [];
    mocks.authority = { mode: 'hosted', transitionState: 'stable', targetMode: null, attemptId: null };
    expect(await needsFirstAccountConnect('subject-a')).toBe(false);
  });

  it('keeps writing on the opened library when the registry cannot be read', async () => {
    runningOn(local);
    const original = mocks.state;
    mocks.state = Promise.reject(new Error('library registry is corrupt')) as never;
    await expect(settleRunningLibrary('subject-a')).resolves.toBeUndefined();
    expect(mocks.activate).not.toHaveBeenCalled();
    mocks.state = original;
  });
});
