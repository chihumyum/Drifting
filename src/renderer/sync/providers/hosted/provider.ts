import {
  assertSchema,
  REMOTE_OBJECT_SCHEMA,
  UPLOAD_RESULT_SCHEMA,
  DOWNLOAD_RESULT_SCHEMA,
  REMOTE_OBJECT_CHANGE_SCHEMA,
  createProviderGenerationRef,
  createProviderCursor,
  createProviderPageToken,
  type ObjectLogProvider,
  type ProviderBinding,
  type ProviderGeneration,
  type RemoteObject,
  type RemoteObjectChange,
  type UploadResult,
  type DownloadResult,
} from '../../protocol';
import type { ProjectSnapshotDiscoveryPort, ProjectSnapshotCandidate } from '../cloud-discovery';
import { ObjectLogProviderError, throwIfProviderAborted } from '../provider-error';
export type HostedNamespace = 'project-v1' | 'agent-chat-v1';
export interface HostedObjectTransport {
  readonly accountSubject: () => string | null;
  request(input: {
    path: string;
    method: 'GET' | 'PUT' | 'DELETE';
    signal?: AbortSignal;
    sourceRef?: string;
    destinationRef?: string;
    objectKind?: string;
    storedSha256?: string;
    sizeBytes?: number;
  }): Promise<unknown>;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ObjectLogProviderError('REMOTE_STORE_CORRUPT', 'Invalid Hosted response');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 8192)
    throw new ObjectLogProviderError('REMOTE_STORE_CORRUPT', 'Invalid Hosted cursor');
  return value;
}
function objects(value: unknown): RemoteObject[] {
  if (!Array.isArray(value) || value.length > 128)
    throw new ObjectLogProviderError('REMOTE_STORE_CORRUPT', 'Invalid Hosted object page');
  return value.map((object) => {
    assertSchema(REMOTE_OBJECT_SCHEMA, object, 'Hosted object');
    return object as RemoteObject;
  });
}
export class HostedObjectLogProvider implements ObjectLogProvider, ProjectSnapshotDiscoveryPort {
  readonly kind = 'hosted' as const;
  private readonly bindings = new Map<string, ProviderBinding>();
  constructor(
    private readonly transport: HostedObjectTransport,
    readonly namespace: HostedNamespace = 'project-v1',
  ) {}
  /** Does not open the generation: deletion must also work after a lost acknowledgement. */
  async deleteProjectGeneration(input: {
    accountSubject: string;
    syncGenerationId: string;
    signal: AbortSignal;
  }): Promise<void> {
    const assertAccount = () => {
      if (this.namespace !== 'project-v1' || !input.accountSubject ||
          input.accountSubject !== this.transport.accountSubject())
        throw new ObjectLogProviderError('INVALID_GENERATION', 'Hosted deletion account changed');
      throwIfProviderAborted(input.signal);
    };
    assertAccount();
    const result = record(await this.transport.request({
      path: `${this.root()}/generations/${encodeURIComponent(input.syncGenerationId)}`,
      method: 'DELETE',
      signal: input.signal,
    }));
    assertAccount();
    if (result.status !== 'deleted' || result.syncGenerationId !== input.syncGenerationId ||
        typeof result.deletedAt !== 'string' || !Number.isFinite(Date.parse(result.deletedAt)))
      throw new ObjectLogProviderError('REMOTE_STORE_CORRUPT', 'Invalid Hosted deletion receipt');
  }
  private root() {
    return `/api/sync/v1/${this.namespace}`;
  }
  private path(generation: ProviderGeneration, suffix = '') {
    const binding = this.bindings.get(generation.generationRef);
    if (
      !binding ||
      binding.bindingId !== generation.bindingId ||
      binding.syncGenerationId !== generation.syncGenerationId ||
      binding.accountRef !== this.transport.accountSubject()
    )
      throw new ObjectLogProviderError(
        'INVALID_GENERATION',
        'Hosted account or generation changed',
      );
    return `${this.root()}/generations/${encodeURIComponent(generation.syncGenerationId)}${suffix}`;
  }
  private async requestFor(
    generation: ProviderGeneration,
    input: Parameters<HostedObjectTransport['request']>[0],
  ) {
    this.path(generation);
    const result = await this.transport.request(input);
    this.path(generation);
    return result;
  }
  async openGeneration(binding: ProviderBinding): Promise<ProviderGeneration> {
    if (
      !binding.accountRef ||
      binding.accountRef !== this.transport.accountSubject() ||
      !binding.syncGenerationId ||
      !binding.bindingId ||
      !Number.isSafeInteger(binding.authorityGeneration) ||
      binding.authorityGeneration < 1
    )
      throw new ObjectLogProviderError(
        'INVALID_GENERATION',
        'Hosted binding does not own the current account',
      );
    const generationRef = createProviderGenerationRef(
      JSON.stringify([
        binding.bindingId,
        binding.syncGenerationId,
        binding.accountRef,
        binding.authorityGeneration,
      ]),
    );
    const previous = this.bindings.get(generationRef);
    if (previous && JSON.stringify(previous) !== JSON.stringify(binding))
      throw new ObjectLogProviderError('INVALID_GENERATION', 'Hosted binding changed');
    this.bindings.set(generationRef, { ...binding });
    const generation = {
      bindingId: binding.bindingId,
      syncGenerationId: binding.syncGenerationId,
      generationRef,
    };
    const result = record(
      await this.requestFor(generation, { path: this.path(generation), method: 'PUT' }),
    );
    if (result.syncGenerationId !== binding.syncGenerationId)
      throw new ObjectLogProviderError('INVALID_GENERATION', 'Hosted opened another generation');
    return generation;
  }
  async captureStartCursor(generation: ProviderGeneration) {
    const result = record(
      await this.requestFor(generation, { path: this.path(generation, '/cursor'), method: 'GET' }),
    );
    return createProviderCursor(text(result.cursor));
  }
  async listInventory(input: Parameters<ObjectLogProvider['listInventory']>[0]) {
    const query = new URLSearchParams(input.pageToken ? { pageToken: input.pageToken } : {});
    const result = record(
      await this.requestFor(input.generation, {
        path: this.path(input.generation, `/inventory?${query}`),
        method: 'GET',
      }),
    );
    return {
      objects: objects(result.objects),
      ...(result.nextPageToken
        ? { nextPageToken: createProviderPageToken(text(result.nextPageToken)) }
        : {}),
    };
  }
  async listChanges(input: Parameters<ObjectLogProvider['listChanges']>[0]) {
    const query = new URLSearchParams({
      cursor: input.cursor,
      ...(input.pageToken ? { pageToken: input.pageToken } : {}),
    });
    const result = record(
      await this.requestFor(input.generation, {
        path: this.path(input.generation, `/changes?${query}`),
        method: 'GET',
      }),
    );
    if (!Array.isArray(result.changes) || result.changes.length > 128)
      throw new ObjectLogProviderError('REMOTE_STORE_CORRUPT', 'Invalid Hosted changes');
    const changes = result.changes.map((change) => {
      assertSchema(REMOTE_OBJECT_CHANGE_SCHEMA, change, 'Hosted change');
      return change as RemoteObjectChange;
    });
    if (!result.nextPageToken && !result.newCursor)
      throw new ObjectLogProviderError('REMOTE_STORE_CORRUPT', 'Missing Hosted cursor');
    return {
      changes,
      ...(result.nextPageToken
        ? { nextPageToken: createProviderPageToken(text(result.nextPageToken)) }
        : { newCursor: createProviderCursor(text(result.newCursor)) }),
    };
  }
  async statImmutable(input: Parameters<ObjectLogProvider['statImmutable']>[0]) {
    const query = new URLSearchParams({ kind: input.objectKind, key: input.logicalKeyId });
    const result = record(
      await this.requestFor(input.generation, {
        path: this.path(input.generation, `/stat?${query}`),
        method: 'GET',
      }),
    );
    if (result.object === null) return null;
    assertSchema(REMOTE_OBJECT_SCHEMA, result.object, 'Hosted stat');
    const object = result.object as RemoteObject;
    if (object.objectKind !== input.objectKind || object.logicalKeyId !== input.logicalKeyId)
      throw new ObjectLogProviderError('REMOTE_STORE_CORRUPT', 'Hosted stat identity mismatch');
    return object;
  }
  async uploadImmutable(input: Parameters<ObjectLogProvider['uploadImmutable']>[0]) {
    throwIfProviderAborted(input.signal);
    const result = await this.requestFor(input.generation, {
      path: this.path(input.generation, `/objects/${encodeURIComponent(input.logicalKeyId)}`),
      method: 'PUT',
      signal: input.signal,
      sourceRef: input.sourceRef,
      objectKind: input.objectKind,
      storedSha256: input.storedSha256,
      sizeBytes: input.sizeBytes,
    });
    throwIfProviderAborted(input.signal);
    assertSchema(UPLOAD_RESULT_SCHEMA, result, 'Hosted upload');
    const uploaded = result as UploadResult;
    if (
      uploaded.object.objectKind !== input.objectKind ||
      uploaded.object.logicalKeyId !== input.logicalKeyId ||
      uploaded.object.storedSha256 !== input.storedSha256 ||
      uploaded.object.sizeBytes !== input.sizeBytes
    ) {
      throw new ObjectLogProviderError(
        'REMOTE_STORE_CORRUPT',
        'Hosted upload acknowledgement mismatch',
      );
    }
    input.onProgress?.({ transferredBytes: input.sizeBytes, totalBytes: input.sizeBytes });
    return uploaded;
  }
  async downloadImmutable(input: Parameters<ObjectLogProvider['downloadImmutable']>[0]) {
    throwIfProviderAborted(input.signal);
    const result = await this.requestFor(input.generation, {
      path: this.path(input.generation, `/objects/${encodeURIComponent(input.objectId)}`),
      method: 'GET',
      signal: input.signal,
      destinationRef: input.destinationRef,
      storedSha256: input.expectedStoredSha256,
    });
    throwIfProviderAborted(input.signal);
    assertSchema(DOWNLOAD_RESULT_SCHEMA, result, 'Hosted download');
    const downloaded = result as DownloadResult;
    if (
      downloaded.destinationRef !== input.destinationRef ||
      downloaded.storedSha256 !== input.expectedStoredSha256
    )
      throw new ObjectLogProviderError('HASH_MISMATCH', 'Hosted download identity mismatch');
    input.onProgress?.({
      transferredBytes: downloaded.sizeBytes,
      totalBytes: downloaded.sizeBytes,
    });
    return downloaded;
  }
  async discover(
    input: Parameters<ProjectSnapshotDiscoveryPort['discover']>[0],
  ): Promise<readonly ProjectSnapshotCandidate[]> {
    if (input.accountSubject !== this.transport.accountSubject())
      throw new ObjectLogProviderError('INVALID_GENERATION', 'Hosted discovery account changed');
    const candidates: ProjectSnapshotCandidate[] = [];
    const seen = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < 10000; page++) {
      throwIfProviderAborted(input.signal);
      const query = new URLSearchParams(pageToken ? { pageToken } : {});
      const result = record(
        await this.transport.request({
          path: `${this.root()}/snapshots?${query}`,
          method: 'GET',
          signal: input.signal,
        }),
      );
      throwIfProviderAborted(input.signal);
      if (input.accountSubject !== this.transport.accountSubject())
        throw new ObjectLogProviderError('INVALID_GENERATION', 'Hosted discovery account changed');
      if (!Array.isArray(result.snapshots) || result.snapshots.length > 128)
        throw new ObjectLogProviderError('REMOTE_STORE_CORRUPT', 'Invalid Hosted discovery page');
      for (const item of result.snapshots) {
        const candidate = record(item);
        const [object] = objects([candidate.object]);
        if (object.objectKind !== 'snapshot-commit')
          throw new ObjectLogProviderError(
            'REMOTE_STORE_CORRUPT',
            'Invalid Hosted discovery object',
          );
        candidates.push({
          syncGenerationId: text(candidate.syncGenerationId),
          object: object as ProjectSnapshotCandidate['object'],
        });
      }
      if (!result.nextPageToken) return candidates;
      pageToken = text(result.nextPageToken);
      if (seen.has(pageToken))
        throw new ObjectLogProviderError(
          'REMOTE_STORE_CORRUPT',
          'Hosted discovery repeated a page',
        );
      seen.add(pageToken);
    }
    throw new ObjectLogProviderError(
      'REMOTE_STORE_CORRUPT',
      'Hosted discovery page bound exceeded',
    );
  }
}
