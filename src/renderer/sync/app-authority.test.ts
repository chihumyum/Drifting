import { describe, expect, it } from 'vitest';
import {
  assertSyncAppAuthority,
  assertUniformSyncProvider,
  beginSyncProviderTransition,
  blockSyncProviderTransition,
  cancelSyncProviderTransition,
  completeSyncProviderTransition,
  createLocalSyncAppAuthority,
  resumeSyncProviderTransition,
  type SyncAppAuthority,
} from './app-authority';

const t0 = '2026-08-15T00:00:00.000Z';
const t1 = '2026-08-15T00:01:00.000Z';

describe('App-wide sync provider authority', () => {
  it('starts in local mode without any provider binding', () => {
    const authority = createLocalSyncAppAuthority(t0);
    expect(() =>
      assertUniformSyncProvider(authority, {
        activeSyncGenerationIds: ['sync-generation-a', 'sync-generation-b'],
        providerAccount: null,
        bindings: [],
      }),
    ).not.toThrow();
    expect(() =>
      assertUniformSyncProvider(authority, {
        activeSyncGenerationIds: ['sync-generation-a'],
        providerAccount: { id: 'google', mode: 'google-drive', authorityGeneration: 1 },
        bindings: [],
      }),
    ).toThrow(/cannot coexist/);
  });

  it('keeps local authoritative until every SyncGeneration has a target receipt', () => {
    const connecting = beginSyncProviderTransition(createLocalSyncAppAuthority(t0), {
      targetMode: 'google-drive',
      attemptId: 'attempt-1',
      now: t1,
    });
    expect(connecting).toMatchObject({
      mode: 'local',
      generation: 1,
      transitionState: 'connecting',
      targetMode: 'google-drive',
    });
    expect(() =>
      completeSyncProviderTransition(connecting, {
        attemptId: 'attempt-1',
        expectedSyncGenerationIds: ['sync-generation-a', 'sync-generation-b'],
        readySyncGenerations: [{ syncGenerationId: 'sync-generation-a', receiptId: 'receipt-a' }],
        now: t1,
      }),
    ).toThrow(/Every active SyncGeneration/);

    const active = completeSyncProviderTransition(connecting, {
      attemptId: 'attempt-1',
      expectedSyncGenerationIds: ['sync-generation-a', 'sync-generation-b'],
      readySyncGenerations: [
        { syncGenerationId: 'sync-generation-b', receiptId: 'receipt-b' },
        { syncGenerationId: 'sync-generation-a', receiptId: 'receipt-a' },
      ],
      now: t1,
    });
    expect(active).toEqual({
      id: 'app',
      mode: 'google-drive',
      generation: 2,
      transitionState: 'stable',
      targetMode: null,
      attemptId: null,
      updatedAt: t1,
    });
  });

  it('switches cloud providers as one new authority generation without dual active providers', () => {
    const drive: SyncAppAuthority = {
      id: 'app',
      mode: 'google-drive',
      generation: 4,
      transitionState: 'stable',
      targetMode: null,
      attemptId: null,
      updatedAt: t0,
    };
    const switching = beginSyncProviderTransition(drive, {
      targetMode: 'hosted',
      attemptId: 'migration-1',
      now: t1,
    });
    expect(switching.transitionState).toBe('switching');
    expect(switching.mode).toBe('google-drive');
    expect(() =>
      assertUniformSyncProvider(switching, {
        activeSyncGenerationIds: ['sync-generation-a'],
        providerAccount: { id: 'hosted-account', mode: 'hosted', authorityGeneration: 4 },
        bindings: [
          {
            syncGenerationId: 'sync-generation-a',
            providerAccountId: 'hosted-account',
            authorityGeneration: 4,
          },
        ],
      }),
    ).toThrow(/does not match/);
    expect(() =>
      assertUniformSyncProvider(switching, {
        activeSyncGenerationIds: ['sync-generation-a'],
        providerAccount: { id: 'drive-account', mode: 'google-drive', authorityGeneration: 4 },
        bindings: [
          {
            syncGenerationId: 'sync-generation-a',
            providerAccountId: 'drive-account',
            authorityGeneration: 4,
          },
        ],
      }),
    ).not.toThrow();
  });

  it('blocks, resumes and cancels without changing the active generation', () => {
    const connecting = beginSyncProviderTransition(createLocalSyncAppAuthority(t0), {
      targetMode: 'google-drive',
      attemptId: 'attempt-1',
      now: t1,
    });
    const blocked = blockSyncProviderTransition(connecting, {
      attemptId: 'attempt-1',
      now: t1,
    });
    expect(blocked.transitionState).toBe('blocked');
    expect(resumeSyncProviderTransition(blocked, { attemptId: 'attempt-1', now: t1 }))
      .toMatchObject({ transitionState: 'connecting', generation: 1, mode: 'local' });
    expect(cancelSyncProviderTransition(blocked, { attemptId: 'attempt-1', now: t1 }))
      .toMatchObject({ transitionState: 'stable', generation: 1, mode: 'local' });
  });

  it('rejects malformed persisted transition rows', () => {
    expect(() =>
      assertSyncAppAuthority({
        id: 'app',
        mode: 'local',
        generation: 1,
        transitionState: 'switching',
        targetMode: 'google-drive',
        attemptId: 'attempt-1',
        updatedAt: t0,
      }),
    ).toThrow(/expected connecting/);
    expect(() =>
      assertSyncAppAuthority({
        id: 'app',
        mode: 'local',
        generation: 1,
        transitionState: 'stable',
        targetMode: 'google-drive',
        attemptId: null,
        updatedAt: t0,
      } as unknown as SyncAppAuthority),
    ).toThrow(/cannot retain/);
  });

  it('requires every cloud SyncGeneration to bind the same account and generation', () => {
    const authority: SyncAppAuthority = {
      id: 'app',
      mode: 'google-drive',
      generation: 3,
      transitionState: 'stable',
      targetMode: null,
      attemptId: null,
      updatedAt: t0,
    };
    expect(() =>
      assertUniformSyncProvider(authority, {
        activeSyncGenerationIds: ['sync-generation-a', 'sync-generation-b'],
        providerAccount: { id: 'account-a', mode: 'google-drive', authorityGeneration: 3 },
        bindings: [
          { syncGenerationId: 'sync-generation-a', providerAccountId: 'account-a', authorityGeneration: 3 },
          { syncGenerationId: 'sync-generation-b', providerAccountId: 'account-b', authorityGeneration: 3 },
        ],
      }),
    ).toThrow(/crosses/);
    expect(() =>
      assertUniformSyncProvider(authority, {
        activeSyncGenerationIds: ['sync-generation-a', 'sync-generation-b'],
        providerAccount: { id: 'account-a', mode: 'google-drive', authorityGeneration: 3 },
        bindings: [
          { syncGenerationId: 'sync-generation-a', providerAccountId: 'account-a', authorityGeneration: 3 },
        ],
      }),
    ).toThrow(/Every active SyncGeneration/);
  });
});
