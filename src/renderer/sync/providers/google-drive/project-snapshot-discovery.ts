import { platform, type GoogleDrivePlatformApi } from '../../../platform';
import {
  assertSchema,
  compareUtf8Bytewise,
  createProviderObjectId,
  REMOTE_OBJECT_SCHEMA,
  type RemoteObject,
} from '../../protocol';

const MAX_DISCOVERY_PAGES = 10_000;

export interface GoogleDriveProjectSnapshotCandidate {
  readonly syncGenerationId: string;
  readonly object: RemoteObject & { readonly objectKind: 'snapshot-commit' };
}

export interface GoogleDriveProjectSnapshotDiscoveryPort {
  discover(input: {
    credentialSecretRef: string;
    accountSubject: string;
    signal: AbortSignal;
  }): Promise<readonly GoogleDriveProjectSnapshotCandidate[]>;
}

function nonEmpty(value: string, label: string): string {
  if (!value.trim() || value.includes('\u0000')) {
    throw new TypeError(`${label} must be a non-empty opaque ID`);
  }
  return value;
}

/** Account-level Drive discovery used before any project generation is known locally. */
export class TauriGoogleDriveProjectSnapshotDiscovery
  implements GoogleDriveProjectSnapshotDiscoveryPort
{
  constructor(private readonly native: GoogleDrivePlatformApi = platform.googleDrive) {}

  async discover(input: {
    credentialSecretRef: string;
    accountSubject: string;
    signal: AbortSignal;
  }): Promise<readonly GoogleDriveProjectSnapshotCandidate[]> {
    nonEmpty(input.credentialSecretRef, 'Google credential secret reference');
    nonEmpty(input.accountSubject, 'Google account subject');
    const candidates = new Map<string, GoogleDriveProjectSnapshotCandidate>();
    const seenPageTokens = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_DISCOVERY_PAGES; page += 1) {
      if (input.signal.aborted) throw input.signal.reason;
      const result = await this.native.discoverProjectSnapshots({
        credentialSecretRef: input.credentialSecretRef,
        accountSubject: input.accountSubject,
        ...(pageToken ? { pageToken } : {}),
      });
      for (const snapshot of result.snapshots) {
        const syncGenerationId = nonEmpty(snapshot.syncGenerationId, 'Discovered project generation ID');
        const object = {
          ...snapshot.object,
          objectId: createProviderObjectId(snapshot.object.objectId),
        } as RemoteObject;
        assertSchema(REMOTE_OBJECT_SCHEMA, object, 'Google Drive snapshot discovery object');
        if (object.objectKind !== 'snapshot-commit') {
          throw new Error('Google Drive project discovery returned a non-commit object');
        }
        const key = JSON.stringify([syncGenerationId, object.objectId]);
        const previous = candidates.get(key);
        if (
          previous &&
          (previous.object.logicalKeyId !== object.logicalKeyId ||
            previous.object.storedSha256 !== object.storedSha256 ||
            previous.object.sizeBytes !== object.sizeBytes)
        ) {
          throw new Error('Google Drive project discovery changed an immutable object identity');
        }
        candidates.set(key, {
          syncGenerationId,
          object: object as GoogleDriveProjectSnapshotCandidate['object'],
        });
      }
      pageToken = result.nextPageToken;
      if (!pageToken) break;
      if (!seenPageTokens.add(pageToken)) {
        throw new Error('Google Drive project discovery repeated a page token');
      }
      if (page === MAX_DISCOVERY_PAGES - 1) {
        throw new Error('Google Drive project discovery exceeded its bounded page count');
      }
    }
    return Object.freeze(
      [...candidates.values()].sort(
        (left, right) =>
          compareUtf8Bytewise(left.syncGenerationId, right.syncGenerationId) ||
          compareUtf8Bytewise(left.object.logicalKeyId, right.object.logicalKeyId) ||
          compareUtf8Bytewise(left.object.objectId, right.object.objectId),
      ),
    );
  }
}
