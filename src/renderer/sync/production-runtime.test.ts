import { describe, expect, it, vi } from 'vitest';

import { events } from '../lib/events';
import type { DbClient } from '../lib/db';
import type { ActiveProviderRuntimeBinding } from './app-authority-repository';
import { SyncEngineCoordinator, type RegisteredSyncGenerationRuntime } from './engine';
import type { SyncWriterIdentitySource } from './journal';
import type { ObjectLogProvider } from './protocol';
import {
  ProductionSyncRuntimeSupervisor,
  type ProductionSyncRuntimeDependencies,
} from './production-runtime';

function binding(syncGenerationId: string, generation = 2): ActiveProviderRuntimeBinding {
  return {
    mode: 'google-drive',
    providerNamespace: 'appDataFolder',
    providerGenerationRef: `syncdrive:${syncGenerationId}`,
    binding: {
      bindingId: `binding:${generation}:${syncGenerationId}`,
      syncGenerationId,
      accountRef: 'google-subject',
      secretRef: 'keychain:google-account',
      authorityGeneration: generation,
    },
  };
}

function dependencies(input: {
  listBindings: ProductionSyncRuntimeDependencies['listBindings'];
}) {
  const database = {} as DbClient;
  const provider = {
    kind: 'google-drive',
  } as unknown as ObjectLogProvider;
  const identity: SyncWriterIdentitySource = {
    installationId: 'install-test',
    createWriterIdentity: () => ({ writerId: 'writer-test', writerEpoch: 'epoch-test' }),
  };
  const runtimeDisposals: string[] = [];
  const installedDisposals: string[] = [];
  const exposedDisposals: string[] = [];
  const errors: unknown[] = [];
  const created: string[] = [];
  const checkpoints: string[] = [];
  const deps: ProductionSyncRuntimeDependencies = {
    database: () => database,
    listBindings: input.listBindings,
    reconcileNativeStorage: vi.fn(async () => undefined),
    writerIdentity: vi.fn(async () => identity),
    createProvider: vi.fn(() => provider),
    createCoordinator: () => new SyncEngineCoordinator(),
    createCheckpoint({ binding: activeBinding }) {
      checkpoints.push(activeBinding.binding.syncGenerationId);
      return { captureIfDue: vi.fn(async () => false) };
    },
    createSyncGenerationRuntime({ binding: activeBinding, checkpoint }): RegisteredSyncGenerationRuntime {
      created.push(activeBinding.binding.syncGenerationId);
      expect(checkpoint).toBeDefined();
      return {
        syncGenerationId: activeBinding.binding.syncGenerationId,
        runCycle: vi.fn(async () => ({
          pulledObjects: 0,
          publishedBlobs: 0,
          publishedSegments: 0,
          checkpointCreated: false,
          converged: true,
          requiresRepull: false,
        })),
        subscribeStatus: () => () => runtimeDisposals.push(activeBinding.binding.syncGenerationId),
      };
    },
    installCoordinator: () => () => installedDisposals.push('signals'),
    exposeCoordinator: () => () => exposedDisposals.push('status'),
    onError: (error) => errors.push(error),
  };
  return {
    deps,
    created,
    checkpoints,
    errors,
    installedDisposals,
    exposedDisposals,
    runtimeDisposals,
  };
}

describe('ProductionSyncRuntimeSupervisor', () => {
  it('keeps prose running when chat fails and schedules durable chat commits independently', async () => {
    vi.useFakeTimers();
    const fixture = dependencies({ listBindings: async () => [{ ...binding('g'), projectId: 'p' }] });
    const prose = vi.fn(async () => ({ pulledObjects: 0, publishedBlobs: 0, publishedSegments: 0, checkpointCreated: false, converged: true, requiresRepull: false }));
    const chat = vi.fn(async () => { throw new Error('Synthetic chat failure'); });
    const deps: ProductionSyncRuntimeDependencies = { ...fixture.deps,
      createSyncGenerationRuntime: () => ({ syncGenerationId: 'g', runCycle: prose }),
      createAgentChatRuntime: () => ({ syncGenerationId: 'g:agent-chat', runCycle: chat }),
      installCoordinator: (coordinator) => { coordinator.triggerStart(); return () => coordinator.shutdown(); },
    };
    const supervisor = new ProductionSyncRuntimeSupervisor(deps);
    try {
      supervisor.requestReload(); await supervisor.drain();
      await vi.advanceTimersByTimeAsync(1);
      expect(prose).toHaveBeenCalledOnce(); expect(chat).toHaveBeenCalledOnce();
      events.emit('agent:conversation-committed', { projectId: 'p' });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(chat.mock.calls.length).toBeGreaterThan(1);
      expect(prose).toHaveBeenCalledOnce();
      supervisor.stop();
      const calls = chat.mock.calls.length;
      events.emit('agent:conversation-committed', { projectId: 'p' });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(chat).toHaveBeenCalledTimes(calls);
    } finally { supervisor.stop(); vi.useRealTimers(); }
  });

  it('keeps the local App provider-free and does not resolve native identity', async () => {
    const fixture = dependencies({ listBindings: vi.fn(async () => []) });
    const supervisor = new ProductionSyncRuntimeSupervisor(fixture.deps);

    supervisor.requestReload();
    await supervisor.drain();

    expect(fixture.deps.createProvider).not.toHaveBeenCalled();
    expect(fixture.deps.writerIdentity).not.toHaveBeenCalled();
    expect(fixture.deps.reconcileNativeStorage).toHaveBeenCalledOnce();
    expect(fixture.created).toEqual([]);
    expect(fixture.checkpoints).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });

  it('mounts all SyncGenerations under one provider and tears the generation down before reload', async () => {
    const listBindings = vi
      .fn<ProductionSyncRuntimeDependencies['listBindings']>()
      .mockResolvedValueOnce([binding('sync-generation-a'), binding('sync-generation-b')])
      .mockResolvedValueOnce([binding('sync-generation-c', 3)]);
    const fixture = dependencies({ listBindings });
    const supervisor = new ProductionSyncRuntimeSupervisor(fixture.deps);

    supervisor.requestReload();
    await supervisor.drain();
    expect(fixture.created).toEqual(['sync-generation-a', 'sync-generation-b']);
    expect(fixture.checkpoints).toEqual(['sync-generation-a', 'sync-generation-b']);

    supervisor.requestReload();
    await supervisor.drain();
    expect(fixture.installedDisposals).toEqual(['signals']);
    expect(fixture.exposedDisposals).toEqual(['status']);
    expect(fixture.runtimeDisposals).toEqual(['sync-generation-b', 'sync-generation-a']);
    expect(fixture.created).toEqual(['sync-generation-a', 'sync-generation-b', 'sync-generation-c']);
    expect(fixture.checkpoints).toEqual(['sync-generation-a', 'sync-generation-b', 'sync-generation-c']);

    supervisor.stop();
    expect(fixture.installedDisposals).toEqual(['signals', 'signals']);
    expect(fixture.exposedDisposals).toEqual(['status', 'status']);
    expect(fixture.runtimeDisposals).toEqual(['sync-generation-b', 'sync-generation-a', 'sync-generation-c']);
    expect(fixture.errors).toEqual([]);
  });

  it('invalidates an in-flight database activation after a database error', async () => {
    let release!: (value: readonly ActiveProviderRuntimeBinding[]) => void;
    const pending = new Promise<readonly ActiveProviderRuntimeBinding[]>((resolve) => {
      release = resolve;
    });
    const fixture = dependencies({ listBindings: vi.fn(() => pending) });
    const supervisor = new ProductionSyncRuntimeSupervisor(fixture.deps);

    supervisor.requestReload();
    supervisor.deactivate();
    release([binding('sync-generation-stale')]);
    await supervisor.drain();

    expect(fixture.created).toEqual([]);
    expect(fixture.deps.createProvider).not.toHaveBeenCalled();
    expect(fixture.errors).toEqual([]);
  });

  it('fails closed if active bindings disagree on provider generation', async () => {
    const fixture = dependencies({
      listBindings: vi.fn(async () => [binding('sync-generation-a', 2), binding('sync-generation-b', 3)]),
    });
    const supervisor = new ProductionSyncRuntimeSupervisor(fixture.deps);

    supervisor.requestReload();
    await supervisor.drain();

    expect(fixture.created).toEqual([]);
    expect(fixture.errors).toHaveLength(1);
    expect(String(fixture.errors[0])).toContain('authority generation');
  });
});
