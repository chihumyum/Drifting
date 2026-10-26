import { ne, sum } from 'drizzle-orm';
import { getDb, type DbExecutor } from '../../lib/db';
import { canUseHostedService } from '../../lib/config';
import { getHostedSessionBinding } from '../../lib/hosted-session-binding';
import { i18next } from '../../lib/i18n';
import { SyncAppAuthorityTable, SyncBlobStateTable } from '../../schema/drizzle';
import { TauriHostedObjectTransport } from '../providers/hosted/tauri-transport';

export interface HostedUsage {
  readonly usedBytes: number;
  readonly quotaBytes: number;
  readonly hardLimitBytes: number;
}

/**
 * Raised before a new attachment is committed to a Hosted-synced library when
 * it would exceed the account's storage quota. The service refuses blobs only
 * at its much higher abuse ceiling, and a refused blob would hold back every
 * later change-set of that project, so the quota is enforced at import.
 */
export class HostedQuotaExceededError extends Error {
  readonly code = 'HOSTED_QUOTA_EXCEEDED';
  constructor(
    readonly usedBytes: number,
    readonly quotaBytes: number,
    readonly requestedBytes: number,
  ) {
    super(
      i18next.t('hostedQuota.exceeded', {
        used: formatStorageBytes(usedBytes),
        quota: formatStorageBytes(quotaBytes),
      }),
    );
    this.name = 'HostedQuotaExceededError';
  }
}

export function formatStorageBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  const megabytes = bytes / (1024 * 1024);
  return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`;
}

const USAGE_MAX_AGE_MS = 60_000;
let cached: { account: string; at: number; usage: HostedUsage } | null = null;

function isUsage(value: unknown): value is HostedUsage {
  if (!value || typeof value !== 'object') return false;
  const usage = value as Record<string, unknown>;
  return ['usedBytes', 'quotaBytes', 'hardLimitBytes'].every(
    (key) => Number.isSafeInteger(usage[key]) && (usage[key] as number) >= 0,
  );
}

/**
 * The signed-in account's server-side usage, or null when Hosted is unavailable.
 * A failed request falls back to the last reading for the same account.
 */
export async function readHostedUsage(
  options: { maxAgeMs?: number; signal?: AbortSignal } = {},
): Promise<HostedUsage | null> {
  const binding = canUseHostedService() ? getHostedSessionBinding() : null;
  if (!binding) return null;
  const maxAgeMs = options.maxAgeMs ?? USAGE_MAX_AGE_MS;
  if (cached?.account === binding.accountSubject && Date.now() - cached.at <= maxAgeMs) {
    return cached.usage;
  }
  try {
    const value = await new TauriHostedObjectTransport().request({
      path: '/api/sync/v1/usage',
      method: 'GET',
      signal: options.signal,
    });
    if (!isUsage(value)) throw new Error('Hosted usage response is malformed');
    cached = { account: binding.accountSubject, at: Date.now(), usage: value };
    return value;
  } catch (error) {
    console.warn('[hosted] usage could not be read:', error);
    return cached?.account === binding.accountSubject ? cached.usage : null;
  }
}

/** Attachment bytes registered locally that the service has not stored yet. */
async function pendingBlobBytes(db: DbExecutor): Promise<number> {
  const [row] = await db
    .select({ bytes: sum(SyncBlobStateTable.sizeBytes) })
    .from(SyncBlobStateTable)
    .where(ne(SyncBlobStateTable.remoteState, 'available'));
  return Number(row?.bytes ?? 0);
}

/**
 * Refuse a new attachment that would take a Hosted library over its quota.
 * Local-only libraries, and Hosted ones whose usage cannot be read (offline,
 * first launch), are never blocked; the service's ceiling stays the backstop.
 */
export async function assertHostedQuotaAllows(
  bytes: number,
  database?: DbExecutor,
): Promise<void> {
  if (!canUseHostedService()) return;
  const db = database ?? getDb();
  const [authority] = await db.select({ mode: SyncAppAuthorityTable.mode }).from(SyncAppAuthorityTable);
  if (authority?.mode !== 'hosted') return;
  const usage = await readHostedUsage();
  if (!usage) return;
  const used = usage.usedBytes + (await pendingBlobBytes(db));
  if (used + bytes > usage.quotaBytes) {
    throw new HostedQuotaExceededError(used, usage.quotaBytes, bytes);
  }
}

/** Tests reset the per-process usage cache. */
export function resetHostedUsageCacheForTests(): void {
  cached = null;
}
