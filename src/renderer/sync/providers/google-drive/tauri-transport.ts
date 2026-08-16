import { platform, type GoogleDrivePlatformApi } from '../../../platform';
import {
  createLocalObjectRef,
  createProviderCursor,
  createProviderObjectId,
  createProviderPageToken,
  type RemoteObject,
  type RemoteObjectChange,
} from '../../protocol';
import {
  createGoogleDriveTransportGenerationRef,
  type GoogleDriveChangePage,
  type GoogleDriveInventoryPage,
  type GoogleDriveObjectTransportPort,
  type GoogleDriveTransportSyncGeneration,
} from './transport';

function remoteObject(value: Awaited<ReturnType<GoogleDrivePlatformApi['statImmutable']>>): RemoteObject | null {
  return value
    ? {
        ...value,
        objectId: createProviderObjectId(value.objectId),
      }
    : null;
}

function remoteChange(
  value: Awaited<ReturnType<GoogleDrivePlatformApi['listChanges']>>['changes'][number],
): RemoteObjectChange {
  if (value.kind === 'present') {
    const object = remoteObject(value.object);
    if (!object) throw new TypeError('Native Google Drive present change omitted its object');
    return { kind: 'present', object };
  }
  return {
    kind: 'removed',
    objectId: createProviderObjectId(value.objectId),
    logicalKeyId: value.logicalKeyId,
  };
}

/** The only product adapter allowed to cross from ObjectLogProvider into Tauri. */
export class TauriGoogleDriveObjectTransport implements GoogleDriveObjectTransportPort {
  constructor(private readonly native: GoogleDrivePlatformApi = platform.googleDrive) {}

  async openGeneration(input: {
    credentialSecretRef: string;
    accountSubject: string;
    bindingId: string;
    syncGenerationId: string;
    authorityGeneration: number;
  }): Promise<GoogleDriveTransportSyncGeneration> {
    const value = await this.native.openGeneration(input);
    return {
      generationRef: createGoogleDriveTransportGenerationRef(value.generationRef),
      syncGenerationId: value.syncGenerationId,
    };
  }

  async captureStartCursor(generation: GoogleDriveTransportSyncGeneration) {
    return createProviderCursor(await this.native.captureStartCursor(generation.generationRef));
  }

  async listInventory(input: {
    generation: GoogleDriveTransportSyncGeneration;
    pageToken?: import('../../protocol').ProviderPageToken;
  }): Promise<GoogleDriveInventoryPage> {
    const page = await this.native.listInventory({
      generationRef: input.generation.generationRef,
      ...(input.pageToken ? { pageToken: input.pageToken } : {}),
    });
    return {
      objects: page.objects.map((object) => {
        const mapped = remoteObject(object);
        if (!mapped) throw new TypeError('Native Google Drive inventory omitted its object');
        return mapped;
      }),
      ...(page.nextPageToken
        ? { nextPageToken: createProviderPageToken(page.nextPageToken) }
        : {}),
    };
  }

  async listChanges(input: {
    generation: GoogleDriveTransportSyncGeneration;
    cursor: import('../../protocol').ProviderCursor;
    pageToken?: import('../../protocol').ProviderPageToken;
  }): Promise<GoogleDriveChangePage> {
    const page = await this.native.listChanges({
      generationRef: input.generation.generationRef,
      cursor: input.cursor,
      ...(input.pageToken ? { pageToken: input.pageToken } : {}),
    });
    return {
      changes: page.changes.map(remoteChange),
      ...(page.nextPageToken
        ? { nextPageToken: createProviderPageToken(page.nextPageToken) }
        : {}),
      ...(page.newCursor ? { newCursor: createProviderCursor(page.newCursor) } : {}),
    };
  }

  async statImmutable(input: Parameters<GoogleDriveObjectTransportPort['statImmutable']>[0]) {
    return remoteObject(
      await this.native.statImmutable({
        generationRef: input.generation.generationRef,
        objectKind: input.objectKind,
        logicalKeyId: input.logicalKeyId,
      }),
    );
  }

  async uploadImmutable(
    input: Parameters<GoogleDriveObjectTransportPort['uploadImmutable']>[0],
  ) {
    const result = await this.native.uploadImmutable({
      generationRef: input.generation.generationRef,
      sourceRef: input.sourceRef,
      objectKind: input.objectKind,
      logicalKeyId: input.logicalKeyId,
      storedSha256: input.storedSha256,
      sizeBytes: input.sizeBytes,
      transferId: input.transferId,
      signal: input.signal,
    });
    const object = remoteObject(result.object);
    if (!object) throw new TypeError('Native Google Drive upload omitted its object');
    return { status: result.status, object };
  }

  async downloadVerifiedImmutable(
    input: Parameters<GoogleDriveObjectTransportPort['downloadVerifiedImmutable']>[0],
  ) {
    const result = await this.native.downloadVerifiedImmutable({
      generationRef: input.generation.generationRef,
      objectId: input.objectId,
      destinationRef: input.destinationRef,
      expectedStoredSha256: input.expectedStoredSha256,
      transferId: input.transferId,
      signal: input.signal,
    });
    return {
      ...result,
      destinationRef: createLocalObjectRef(result.destinationRef),
    };
  }
}
