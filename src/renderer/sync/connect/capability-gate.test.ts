import { describe, expect, it } from 'vitest';

import type { PlatformCapabilities } from '../../platform/contracts';
import {
  assertGoogleDriveInitialConnectCapabilities,
  GoogleDriveInitialConnectCapabilityError,
} from './capability-gate';

function capabilities(
  overrides: Partial<PlatformCapabilities['featureStatus']> = {},
): PlatformCapabilities {
  return {
    runtime: 'tauri',
    target: 'desktop',
    desktopWindowControls: false,
    deepLinks: true,
    externalUrlOpener: true,
    generalAgent: false,
    generalAgentUnavailableReason: '',
    mcpStdio: false,
    featureStatus: {
      secureStorage: 'available',
      syncObjectStore: 'available',
      googleDriveTransport: 'available',
      googleDriveOAuth: 'available',
      materialFiles: 'available',
      assetStore: 'available',
      aiLog: 'available',
      oauth: 'available',
      mcpStdio: 'unsupported',
      generalAgent: 'unsupported',
      ...overrides,
    },
  };
}

describe('Google Drive initial-connect capability gate', () => {
  it('requires OAuth, Drive transport, and native opaque-object staging', () => {
    expect(() => assertGoogleDriveInitialConnectCapabilities(capabilities())).not.toThrow();

    for (const [field, code] of [
      ['googleDriveOAuth', 'GOOGLE_DRIVE_OAUTH_UNAVAILABLE'],
      ['googleDriveTransport', 'GOOGLE_DRIVE_TRANSPORT_UNAVAILABLE'],
      ['syncObjectStore', 'SYNC_OBJECT_STORE_UNAVAILABLE'],
    ] as const) {
      try {
        assertGoogleDriveInitialConnectCapabilities(capabilities({ [field]: 'unsupported' }));
        throw new Error('expected capability failure');
      } catch (error) {
        expect(error).toBeInstanceOf(GoogleDriveInitialConnectCapabilityError);
        expect(error).toMatchObject({ code });
      }
    }
  });
});
