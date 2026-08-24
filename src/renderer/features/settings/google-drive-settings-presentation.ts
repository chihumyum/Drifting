import type {
  GoogleDriveNativeErrorCode,
  PlatformCapabilities,
} from '../../platform/contracts';

type GoogleDriveCapabilityId = 'oauth' | 'transport' | 'object-store';

export interface GoogleDriveSettingsReadiness {
  available: boolean;
  missing: readonly GoogleDriveCapabilityId[];
  descriptionKey: string;
}

/**
 * Product connection requires all three native seams. Keeping this projection
 * next to Settings prevents an enabled OAuth button from failing later because
 * Drive transport or opaque local staging is absent from the running build.
 */
export function resolveGoogleDriveSettingsReadiness(
  capabilities: PlatformCapabilities | null,
): GoogleDriveSettingsReadiness {
  const missing: GoogleDriveCapabilityId[] = [];
  if (capabilities?.featureStatus.googleDriveOAuth !== 'available') missing.push('oauth');
  if (capabilities?.featureStatus.googleDriveTransport !== 'available') {
    missing.push('transport');
  }
  if (capabilities?.featureStatus.syncObjectStore !== 'available') missing.push('object-store');

  const descriptionKey =
    missing.length === 0
      ? 'settings.sync.device_readiness_ready_desc'
      : missing.includes('oauth')
        ? 'settings.sync.device_readiness_oauth_desc'
        : missing.includes('transport')
          ? 'settings.sync.device_readiness_transport_desc'
          : 'settings.sync.device_readiness_storage_desc';
  return Object.freeze({
    available: missing.length === 0,
    missing: Object.freeze(missing),
    descriptionKey,
  });
}

export type GoogleDriveSettingsIssueId =
  | 'configuration'
  | 'offline'
  | 'reauthorize'
  | 'account-mismatch'
  | 'permission'
  | 'rate-limited'
  | 'quota'
  | 'cancelled'
  | 'update-required'
  | 'data-integrity'
  | 'retry';

export interface GoogleDriveSettingsIssue {
  id: GoogleDriveSettingsIssueId;
  code: string;
  titleKey: string;
  descriptionKey: string;
}

function safeIssueCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, 64);
  if (!trimmed) return null;
  return trimmed.replace(/[^A-Za-z0-9_.-]/gu, '-');
}

function issueCode(input: unknown): string | null {
  if (typeof input === 'string') return safeIssueCode(input);
  if (!input || typeof input !== 'object' || !('code' in input)) return null;
  return safeIssueCode((input as { code?: unknown }).code);
}

const CONFIGURATION_CODES = new Set([
  'configuration-required',
  'unsupported-platform',
  'GOOGLE_DRIVE_OAUTH_UNAVAILABLE',
  'GOOGLE_DRIVE_TRANSPORT_UNAVAILABLE',
  'SYNC_OBJECT_STORE_UNAVAILABLE',
]);
const DATA_INTEGRITY_CODES = new Set([
  'blocked-corrupt',
  'remote-corrupt',
  'immutable-conflict',
  'invalid-cursor',
  'invalid-page-token',
  'invalid-request',
  'local-object-invalid',
  'remote-object-missing',
  'local-project-sync-conflict',
]);
const NATIVE_ISSUE_IDS = Object.freeze({
  cancelled: 'cancelled',
  offline: 'offline',
  'needs-reauth': 'reauthorize',
  'permission-denied': 'permission',
  'rate-limited': 'rate-limited',
  'quota-exceeded': 'quota',
  transient: 'retry',
  'invalid-cursor': 'retry',
  'invalid-page-token': 'data-integrity',
  'invalid-request': 'data-integrity',
  'local-object-invalid': 'data-integrity',
  'remote-object-missing': 'data-integrity',
  'immutable-conflict': 'data-integrity',
  'remote-corrupt': 'data-integrity',
  'configuration-required': 'configuration',
  'account-mismatch': 'account-mismatch',
  'unsupported-platform': 'configuration',
} satisfies Readonly<Record<GoogleDriveNativeErrorCode, GoogleDriveSettingsIssueId>>);
const ACTIONABLE_CODES = new Set([
  ...Object.keys(NATIVE_ISSUE_IDS),
  ...CONFIGURATION_CODES,
  ...DATA_INTEGRITY_CODES,
  'blocked-update',
  'SYNC_CYCLE_FAILED',
  'SYNC_AUTHORITY_UNAVAILABLE',
  'CANCELLED',
  'DISCONNECT_FAILED',
  'UPLOAD_FAILED',
]);

export function resolveGoogleDriveSettingsIssue(
  input: unknown,
): GoogleDriveSettingsIssue | null {
  if (input === null || input === undefined) return null;
  const candidate = issueCode(input);
  const code = candidate && ACTIONABLE_CODES.has(candidate) ? candidate : 'unexpected';
  let id: GoogleDriveSettingsIssueId;
  const nativeIssueId = NATIVE_ISSUE_IDS[code as GoogleDriveNativeErrorCode];
  if (nativeIssueId) id = nativeIssueId;
  else if (CONFIGURATION_CODES.has(code)) id = 'configuration';
  else if (code === 'CANCELLED') id = 'cancelled';
  else if (code === 'blocked-update') id = 'update-required';
  else if (DATA_INTEGRITY_CODES.has(code)) id = 'data-integrity';
  else id = 'retry';

  return Object.freeze({
    id,
    code,
    titleKey: `settings.sync.issues.${id}.title`,
    descriptionKey: `settings.sync.issues.${id}.desc`,
  });
}
