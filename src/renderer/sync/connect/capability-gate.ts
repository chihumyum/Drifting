import type { PlatformCapabilities } from '../../platform/contracts';

export type GoogleDriveInitialConnectCapabilityErrorCode =
  | 'GOOGLE_DRIVE_OAUTH_UNAVAILABLE'
  | 'GOOGLE_DRIVE_TRANSPORT_UNAVAILABLE'
  | 'SYNC_OBJECT_STORE_UNAVAILABLE';

export class GoogleDriveInitialConnectCapabilityError extends Error {
  readonly code: GoogleDriveInitialConnectCapabilityErrorCode;

  constructor(code: GoogleDriveInitialConnectCapabilityErrorCode, message: string) {
    super(message);
    this.name = 'GoogleDriveInitialConnectCapabilityError';
    this.code = code;
  }
}

/** Trusted-cloud sync requires OAuth, native Drive transport and opaque files. */
export function assertGoogleDriveInitialConnectCapabilities(
  capabilities: PlatformCapabilities | null,
): void {
  if (capabilities?.featureStatus.googleDriveOAuth !== 'available') {
    throw new GoogleDriveInitialConnectCapabilityError(
      'GOOGLE_DRIVE_OAUTH_UNAVAILABLE',
      'Google Drive OAuth is unavailable in this platform build',
    );
  }
  if (capabilities.featureStatus.googleDriveTransport !== 'available') {
    throw new GoogleDriveInitialConnectCapabilityError(
      'GOOGLE_DRIVE_TRANSPORT_UNAVAILABLE',
      'Google Drive object transport is unavailable in this platform build',
    );
  }
  if (capabilities.featureStatus.syncObjectStore !== 'available') {
    throw new GoogleDriveInitialConnectCapabilityError(
      'SYNC_OBJECT_STORE_UNAVAILABLE',
      'Native SyncEngine object staging is unavailable in this platform build',
    );
  }
}
