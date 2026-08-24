import { describe, expect, it } from 'vitest';
import type {
  GoogleDriveNativeErrorCode,
  PlatformCapabilities,
} from '../../platform/contracts';
import {
  resolveGoogleDriveSettingsIssue,
  resolveGoogleDriveSettingsReadiness,
} from './google-drive-settings-presentation';

function capabilities(
  overrides: Partial<PlatformCapabilities['featureStatus']> = {},
): PlatformCapabilities {
  return {
    runtime: 'tauri',
    target: 'mobile',
    desktopWindowControls: false,
    deepLinks: true,
    externalUrlOpener: true,
    generalAgent: true,
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
      generalAgent: 'available',
      ...overrides,
    },
  };
}

describe('Google Drive Settings presentation', () => {
  it('enables connection only when OAuth, Drive transport, and opaque staging are ready', () => {
    expect(resolveGoogleDriveSettingsReadiness(capabilities())).toMatchObject({
      available: true,
      missing: [],
    });
    expect(
      resolveGoogleDriveSettingsReadiness(
        capabilities({ googleDriveTransport: 'contract-backed' }),
      ),
    ).toMatchObject({
      available: false,
      missing: ['transport'],
      descriptionKey: 'settings.sync.device_readiness_transport_desc',
    });
    expect(resolveGoogleDriveSettingsReadiness(null)).toMatchObject({
      available: false,
      missing: ['oauth', 'transport', 'object-store'],
    });
  });

  it.each([
    ['account-mismatch', 'account-mismatch'],
    ['needs-reauth', 'reauthorize'],
    ['permission-denied', 'permission'],
    ['offline', 'offline'],
    ['rate-limited', 'rate-limited'],
    ['quota-exceeded', 'quota'],
    ['blocked-update', 'update-required'],
    ['remote-corrupt', 'data-integrity'],
    ['configuration-required', 'configuration'],
  ])('maps %s to an actionable, localized issue', (code, id) => {
    expect(resolveGoogleDriveSettingsIssue({ code, message: 'must not be rendered' })).toEqual({
      id,
      code,
      titleKey: `settings.sync.issues.${id}.title`,
      descriptionKey: `settings.sync.issues.${id}.desc`,
    });
  });

  it.each(
    [
      ['cancelled', 'cancelled'],
      ['offline', 'offline'],
      ['needs-reauth', 'reauthorize'],
      ['permission-denied', 'permission'],
      ['rate-limited', 'rate-limited'],
      ['quota-exceeded', 'quota'],
      ['transient', 'retry'],
      ['invalid-cursor', 'retry'],
      ['invalid-page-token', 'data-integrity'],
      ['invalid-request', 'data-integrity'],
      ['local-object-invalid', 'data-integrity'],
      ['remote-object-missing', 'data-integrity'],
      ['immutable-conflict', 'data-integrity'],
      ['remote-corrupt', 'data-integrity'],
      ['configuration-required', 'configuration'],
      ['account-mismatch', 'account-mismatch'],
      ['unsupported-platform', 'configuration'],
    ] satisfies ReadonlyArray<[GoogleDriveNativeErrorCode, string]>,
  )('preserves native contract code %s as %s', (code, id) => {
    expect(resolveGoogleDriveSettingsIssue(code)).toMatchObject({ code, id });
  });

  it('never projects an arbitrary error message or unsafe reason code', () => {
    expect(
      resolveGoogleDriveSettingsIssue({
        code: 'bad code / account@example.com',
        message: 'secret material',
      }),
    ).toEqual({
      id: 'retry',
      code: 'unexpected',
      titleKey: 'settings.sync.issues.retry.title',
      descriptionKey: 'settings.sync.issues.retry.desc',
    });
    expect(resolveGoogleDriveSettingsIssue(new Error('private path'))).toMatchObject({
      id: 'retry',
      code: 'unexpected',
    });
  });
});
