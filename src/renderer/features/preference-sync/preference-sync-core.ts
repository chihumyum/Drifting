/**
 * Account preferences: the settings that follow the author across devices
 * (docs/hosted-sync/preferences.md). Each device keeps its own values and a
 * ledger of when it last changed each one; the service keeps, per key, the
 * change with the latest time. This module is the merge, free of stores and
 * network so two devices can be exercised side by side.
 */

/** A stored preference as the service returns it. */
export interface RemotePreference {
  value: unknown;
  changedAt: string;
}
export type RemotePreferences = Record<string, RemotePreference>;

export interface PreferenceWrite {
  key: string;
  value: unknown;
  changedAt: string;
}

export interface PreferenceTransport {
  read(signal: AbortSignal): Promise<RemotePreferences>;
  write(entries: PreferenceWrite[], signal: AbortSignal): Promise<RemotePreferences>;
}

/** This device's synced settings: read the JSON value, or apply one from another device. */
export interface PreferenceSurface {
  readonly keys: readonly string[];
  read(key: string): unknown;
  /** False when the value is not one this version understands; nothing changes then. */
  apply(key: string, value: unknown): boolean;
}

export interface PreferenceLedgerEntry {
  /** When this device last changed the value, or adopted the account's. */
  changedAt: string;
  /** Changed here and not yet accepted by the account. */
  pending: boolean;
}

export interface PreferenceLedger {
  /** The account this device last synced with; null before the first sync. */
  accountId: string | null;
  entries: Record<string, PreferenceLedgerEntry>;
}

/** A value this device never changed seeds the account but loses to any real change. */
export const UNCHANGED_AT = '1970-01-01T00:00:00.000Z';

export const emptyPreferenceLedger = (): PreferenceLedger => ({ accountId: null, entries: {} });

const time = (iso: string) => {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
};

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Marks the keys whose value differs from `previous` as changed here at `now`. */
export function recordPreferenceChanges(
  ledger: PreferenceLedger,
  previous: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
  now: string,
): string[] {
  const changed: string[] = [];
  for (const [key, value] of current) {
    if (previous.get(key) === value) continue;
    ledger.entries[key] = { changedAt: now, pending: true };
    changed.push(key);
  }
  return changed;
}

/**
 * One exchange with the account: send what changed here since the account last
 * saw it (and values the account does not hold yet), then adopt every key where
 * the account holds a later change. Mutates and returns the ledger.
 */
export async function syncPreferences(input: {
  accountId: string;
  surface: PreferenceSurface;
  ledger: PreferenceLedger;
  transport: PreferenceTransport;
  signal: AbortSignal;
}): Promise<PreferenceLedger> {
  const { accountId, surface, ledger, transport, signal } = input;
  if (ledger.accountId !== accountId) {
    // Another account's settings were changed under that account; this one's apply.
    if (ledger.accountId !== null) for (const entry of Object.values(ledger.entries)) entry.pending = false;
    ledger.accountId = accountId;
  }
  let remote = await transport.read(signal);
  const writes: PreferenceWrite[] = [];
  for (const key of surface.keys) {
    const local = ledger.entries[key];
    const stored = remote[key];
    if (!stored) writes.push({ key, value: surface.read(key), changedAt: local?.changedAt ?? UNCHANGED_AT });
    else if (local?.pending && time(local.changedAt) > time(stored.changedAt))
      writes.push({ key, value: surface.read(key), changedAt: local.changedAt });
  }
  if (writes.length) remote = await transport.write(writes, signal);
  signal.throwIfAborted();
  for (const key of surface.keys) {
    const stored = remote[key];
    if (!stored) continue;
    const local = ledger.entries[key];
    const current = surface.read(key);
    if (local?.pending && time(local.changedAt) > time(stored.changedAt) && !sameValue(current, stored.value))
      continue; // Changed again while the request ran; the next exchange sends it.
    if (!sameValue(current, stored.value)) surface.apply(key, stored.value);
    ledger.entries[key] = { changedAt: stored.changedAt, pending: false };
  }
  return ledger;
}
