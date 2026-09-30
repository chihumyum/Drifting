import type { RemoteObject } from '../protocol';
export interface CloudProviderAccount {
  readonly accountSubject: string;
  readonly credentialSecretRef: string;
}
export interface ProjectSnapshotCandidate {
  readonly syncGenerationId: string;
  readonly object: RemoteObject & { readonly objectKind: 'snapshot-commit' };
}
export interface ProjectSnapshotDiscoveryPort {
  discover(
    input: CloudProviderAccount & { readonly signal: AbortSignal },
  ): Promise<readonly ProjectSnapshotCandidate[]>;
}
