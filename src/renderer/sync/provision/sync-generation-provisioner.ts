import type { DbClient } from '../../lib/db';
import type { PublishedProviderSnapshot } from '../checkpoint';
import { sha256Bytes, type ObjectLogProvider, type ProviderGeneration } from '../protocol';
import type { PendingSyncGenerationProvision } from './repository';
import { SyncGenerationProvisionRepository } from './repository';

interface SnapshotPublisherPort {
  publishSnapshot(input: {
    snapshotId: string;
    snapshotKind: 'genesis';
    signal: AbortSignal;
  }): Promise<PublishedProviderSnapshot>;
}

export interface SyncGenerationProvisionerDependencies {
  readonly db: DbClient;
  readonly repository: SyncGenerationProvisionRepository;
  readonly createProvider: (mode: PendingSyncGenerationProvision['mode']) => ObjectLogProvider;
  readonly createSnapshotPublisher: (input: {
    pending: PendingSyncGenerationProvision;
    provider: ObjectLogProvider;
    providerGeneration: ProviderGeneration;
  }) => SnapshotPublisherPort;
  readonly emitAuthorityChanged: () => void;
}

async function genesisId(pending: PendingSyncGenerationProvision): Promise<string> {
  const hash = await sha256Bytes(
    new TextEncoder().encode(
      `provision\0${pending.authorityGeneration}\0${pending.syncGenerationId}\0${pending.generationNumber}`,
    ),
  );
  return `genesis-provision-${hash.slice('sha256:'.length)}`;
}

/** Provisions exactly one already-durable pending project generation. */
export class PendingSyncGenerationProvisioner {
  constructor(private readonly dependencies: SyncGenerationProvisionerDependencies) {}

  async provision(pending: PendingSyncGenerationProvision, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new DOMException('Project provisioning aborted', 'AbortError');
    const provider = this.dependencies.createProvider(pending.mode);
    const providerGeneration = await provider.openGeneration(pending.binding);
    const snapshot = await this.dependencies
      .createSnapshotPublisher({ pending, provider, providerGeneration })
      .publishSnapshot({
        snapshotId: await genesisId(pending),
        snapshotKind: 'genesis',
        signal,
      });
    await this.dependencies.repository.markReady({
      pending,
      genesisCheckpointId: snapshot.checkpointId,
    });
    this.dependencies.emitAuthorityChanged();
  }
}
