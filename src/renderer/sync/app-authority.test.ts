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
        providerAccount: { id: 'hosted', mode: 'hosted', authorityGeneration: 1 },
        bindings: [],
      }),
    ).toThrow(/cannot coexist/);
  });

  it('keeps local authoritative until every SyncGeneration has a target receipt', () => {
    const connecting = beginSyncProviderTransition(createLocalSyncAppAuthority(t0), {
      targetMode: 'hosted',
      attemptId: 'attempt-1',
      now: t1,
    });
    expect(connecting).toMatchObject({
      mode: 'local',
      generation: 1,
      transitionState: 'connecting',
      targetMode: 'hosted',
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
      mode: 'hosted',
      generation: 2,
      transitionState: 'stable',
      targetMode: null,
      attemptId: null,
      updatedAt: t1,
    });
  });

  it('disconnects Hosted as one new authority generation while Hosted stays authoritative', () => {
    const hosted: SyncAppAuthority = {
      id: 'app',
      mode: 'hosted',
      generation: 4,
      transitionState: 'stable',
      targetMode: null,
      attemptId: null,
      updatedAt: t0,
    };
    expect(() =>
      beginSyncProviderTransition(hosted, { targetMode: 'hosted', attemptId: 'again', now: t1 }),
    ).toThrow(/already hosted/);
    const disconnecting = beginSyncProviderTransition(hosted, {
      targetMode: 'local',
      attemptId: 'disconnect-1',
      now: t1,
    });
    expect(disconnecting).toMatchObject({
      mode: 'hosted',
      generation: 4,
      transitionState: 'disconnecting',
      targetMode: 'local',
    });
    expect(() =>
      assertUniformSyncProvider(disconnecting, {
        activeSyncGenerationIds: ['sync-generation-a'],
        providerAccount: { id: 'hosted-account', mode: 'hosted', authorityGeneration: 3 },
        bindings: [
          {
            syncGenerationId: 'sync-generation-a',
            providerAccountId: 'hosted-account',
            authorityGeneration: 3,
          },
        ],
      }),
    ).toThrow(/does not match/);
    expect(() =>
      assertUniformSyncProvider(disconnecting, {
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
    ).not.toThrow();
    expect(
      completeSyncProviderTransition(disconnecting, {
        attemptId: 'disconnect-1',
        expectedSyncGenerationIds: ['sync-generation-a'],
        readySyncGenerations: [{ syncGenerationId: 'sync-generation-a', receiptId: 'receipt-a' }],
        now: t1,
      }),
    ).toEqual({
      id: 'app',
      mode: 'local',
      generation: 5,
      transitionState: 'stable',
      targetMode: null,
      attemptId: null,
      updatedAt: t1,
    });
  });

  it('blocks, resumes and cancels without changing the active generation', () => {
    const connecting = beginSyncProviderTransition(createLocalSyncAppAuthority(t0), {
      targetMode: 'hosted',
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
        targetMode: 'hosted',
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
        targetMode: 'hosted',
        attemptId: null,
        updatedAt: t0,
      } as unknown as SyncAppAuthority),
    ).toThrow(/cannot retain/);
    expect(() =>
      assertSyncAppAuthority({
        id: 'app',
        mode: 'google-drive',
        generation: 2,
        transitionState: 'stable',
        targetMode: null,
        attemptId: null,
        updatedAt: t0,
      } as unknown as SyncAppAuthority),
    ).toThrow(/Unknown sync provider mode/);
    expect(() =>
      assertSyncAppAuthority({
        id: 'app',
        mode: 'local',
        generation: 1,
        transitionState: 'blocked',
        targetMode: 'google-drive',
        attemptId: 'attempt-1',
        updatedAt: t0,
      } as unknown as SyncAppAuthority),
    ).toThrow(/Unknown target sync provider mode/);
  });

  it('requires every cloud SyncGeneration to bind the same account and generation', () => {
    const authority: SyncAppAuthority = {
      id: 'app',
      mode: 'hosted',
      generation: 3,
      transitionState: 'stable',
      targetMode: null,
      attemptId: null,
      updatedAt: t0,
    };
    expect(() =>
      assertUniformSyncProvider(authority, {
        activeSyncGenerationIds: ['sync-generation-a', 'sync-generation-b'],
        providerAccount: { id: 'account-a', mode: 'hosted', authorityGeneration: 3 },
        bindings: [
          { syncGenerationId: 'sync-generation-a', providerAccountId: 'account-a', authorityGeneration: 3 },
          { syncGenerationId: 'sync-generation-b', providerAccountId: 'account-b', authorityGeneration: 3 },
        ],
      }),
    ).toThrow(/crosses/);
    expect(() =>
      assertUniformSyncProvider(authority, {
        activeSyncGenerationIds: ['sync-generation-a', 'sync-generation-b'],
        providerAccount: { id: 'account-a', mode: 'hosted', authorityGeneration: 3 },
        bindings: [
          { syncGenerationId: 'sync-generation-a', providerAccountId: 'account-a', authorityGeneration: 3 },
        ],
      }),
    ).toThrow(/Every active SyncGeneration/);
  });
});
