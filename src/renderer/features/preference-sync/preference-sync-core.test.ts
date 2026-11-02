import { describe, expect, it } from 'vitest';
import {
  emptyPreferenceLedger,
  recordPreferenceChanges,
  syncPreferences,
  UNCHANGED_AT,
  type PreferenceSurface,
  type PreferenceTransport,
  type PreferenceWrite,
  type RemotePreferences,
} from './preference-sync-core';

/** The service's rule: per key, keep the write with the latest changedAt, clamped to its clock. */
function account(clock: () => string) {
  const bags = new Map<string, RemotePreferences>();
  const writes: PreferenceWrite[][] = [];
  const transport = (accountId: string): PreferenceTransport => ({
    async read() {
      return structuredClone(bags.get(accountId) ?? {});
    },
    async write(entries) {
      writes.push(entries);
      const bag = bags.get(accountId) ?? {};
      for (const entry of entries) {
        const changedAt = entry.changedAt > clock() ? clock() : entry.changedAt;
        if (!bag[entry.key] || changedAt > bag[entry.key].changedAt)
          bag[entry.key] = { value: structuredClone(entry.value), changedAt };
      }
      bags.set(accountId, bag);
      return structuredClone(bag);
    },
  });
  return { transport, writes, bag: (accountId: string) => bags.get(accountId) ?? {} };
}

const KEYS = ['themeMode', 'bodyFontSize', 'caretColor'] as const;
const DEFAULTS = { themeMode: 'light', bodyFontSize: 17, caretColor: '#6b7fa6' };

/** One device: its settings, its ledger and the snapshot it records changes against. */
function device(name: string, values: Partial<typeof DEFAULTS> = {}) {
  const state: Record<string, unknown> = { ...DEFAULTS, ...values };
  const ledger = emptyPreferenceLedger();
  const snapshot = () => new Map(KEYS.map((key) => [key, JSON.stringify(state[key])]));
  const surface: PreferenceSurface = {
    keys: KEYS,
    read: (key) => state[key],
    apply(key, value) {
      if (key === 'themeMode' && !['light', 'dark', 'system'].includes(value as string)) return false;
      state[key] = value;
      return true;
    },
  };
  return {
    name,
    state,
    ledger,
    change(key: (typeof KEYS)[number], value: unknown, at: string) {
      const before = snapshot();
      state[key] = value;
      recordPreferenceChanges(ledger, before, snapshot(), at);
    },
    sync(service: ReturnType<typeof account>, accountId = 'author', duringWrite?: () => void) {
      const transport = service.transport(accountId);
      return syncPreferences({
        accountId,
        surface,
        ledger,
        signal: new AbortController().signal,
        transport: duringWrite
          ? { ...transport, write: async (entries, signal) => { const result = await transport.write(entries, signal); duringWrite(); return result; } }
          : transport,
      });
    },
  };
}

const clock = () => '2026-11-02T08:00:00.000Z';

describe('account preferences merge', () => {
  it('carries a change from one device to another', async () => {
    const service = account(clock);
    const mac = device('mac');
    const air = device('air');
    await mac.sync(service);
    await air.sync(service);
    mac.change('themeMode', 'dark', '2026-11-02T07:00:00.000Z');
    await mac.sync(service);
    await air.sync(service);
    expect(air.state.themeMode).toBe('dark');
    expect(air.ledger.entries.themeMode).toEqual({ changedAt: '2026-11-02T07:00:00.000Z', pending: false });
  });

  it('keeps the later of two offline changes to one setting, and both to different settings', async () => {
    const service = account(clock);
    const mac = device('mac');
    const air = device('air');
    await mac.sync(service);
    await air.sync(service);
    mac.change('bodyFontSize', 19, '2026-11-02T07:10:00.000Z');
    air.change('bodyFontSize', 21, '2026-11-02T07:20:00.000Z');
    air.change('caretColor', '#112233', '2026-11-02T07:05:00.000Z');
    mac.change('themeMode', 'system', '2026-11-02T07:30:00.000Z');
    // The later change reaches the service first; the earlier one must not overwrite it.
    await air.sync(service);
    await mac.sync(service);
    await air.sync(service);
    for (const side of [mac, air]) expect(side.state).toEqual({ themeMode: 'system', bodyFontSize: 21, caretColor: '#112233' });
    expect(Object.values(mac.ledger.entries).every((entry) => !entry.pending)).toBe(true);
  });

  it('gives a new device the account settings, while values it never changed only fill gaps', async () => {
    const service = account(clock);
    const mac = device('mac');
    mac.change('themeMode', 'dark', '2026-11-02T06:00:00.000Z');
    await mac.sync(service);
    expect(service.bag('author').bodyFontSize).toEqual({ value: 17, changedAt: UNCHANGED_AT });
    const air = device('air', { bodyFontSize: 15 });
    await air.sync(service);
    expect(air.state).toEqual({ themeMode: 'dark', bodyFontSize: 17, caretColor: '#6b7fa6' });
  });

  it('lets a change made here before signing in win only when it is the later one', async () => {
    const service = account(clock);
    const mac = device('mac');
    mac.change('themeMode', 'dark', '2026-11-02T06:00:00.000Z');
    mac.change('caretColor', '#445566', '2026-11-02T06:00:00.000Z');
    await mac.sync(service);
    const air = device('air');
    air.change('themeMode', 'system', '2026-11-02T05:00:00.000Z');
    air.change('caretColor', '#998877', '2026-11-02T07:00:00.000Z');
    await air.sync(service);
    expect(air.state.themeMode).toBe('dark');
    expect(air.state.caretColor).toBe('#998877');
    await mac.sync(service);
    expect(mac.state.caretColor).toBe('#998877');
  });

  it('switching accounts applies the new account settings instead of carrying the old ones over', async () => {
    const service = account(clock);
    const other = device('other');
    other.change('themeMode', 'system', '2026-11-02T05:00:00.000Z');
    await other.sync(service, 'second');
    const mac = device('mac');
    await mac.sync(service, 'first');
    mac.change('themeMode', 'dark', '2026-11-02T07:00:00.000Z');
    // Signed out before it reached the first account, then signed in to the second.
    await mac.sync(service, 'second');
    expect(mac.state.themeMode).toBe('system');
    expect(service.bag('first').themeMode.value).toBe('light');
    expect(service.bag('second').themeMode.value).toBe('system');
  });

  it('leaves alone a value this version does not understand, without sending anything back', async () => {
    const service = account(clock);
    const mac = device('mac');
    await mac.sync(service);
    await service.transport('author').write([{ key: 'themeMode', value: 'sepia', changedAt: '2026-11-02T07:00:00.000Z' }], new AbortController().signal);
    const before = service.writes.length;
    await mac.sync(service);
    expect(mac.state.themeMode).toBe('light');
    expect(mac.ledger.entries.themeMode).toEqual({ changedAt: '2026-11-02T07:00:00.000Z', pending: false });
    expect(service.writes.length).toBe(before);
  });

  it('settles a change from a clock running ahead instead of sending it forever', async () => {
    const service = account(clock);
    const mac = device('mac');
    await mac.sync(service);
    mac.change('bodyFontSize', 20, '2030-01-01T00:00:00.000Z');
    await mac.sync(service);
    expect(service.bag('author').bodyFontSize).toEqual({ value: 20, changedAt: clock() });
    expect(mac.ledger.entries.bodyFontSize).toEqual({ changedAt: clock(), pending: false });
    const before = service.writes.length;
    await mac.sync(service);
    expect(service.writes.length).toBe(before);
  });

  it('keeps a change made while its previous value is being sent for the next exchange', async () => {
    const service = account(clock);
    const mac = device('mac');
    await mac.sync(service);
    mac.change('themeMode', 'dark', '2026-11-02T07:58:00.000Z');
    await mac.sync(service, 'author', () => mac.change('themeMode', 'system', '2026-11-02T07:59:00.000Z'));
    expect(service.bag('author').themeMode.value).toBe('dark');
    expect(mac.state.themeMode).toBe('system');
    expect(mac.ledger.entries.themeMode).toEqual({ changedAt: '2026-11-02T07:59:00.000Z', pending: true });
    await mac.sync(service);
    expect(service.bag('author').themeMode.value).toBe('system');
    expect(mac.ledger.entries.themeMode.pending).toBe(false);
  });

  it('sends nothing when nothing changed', async () => {
    const service = account(clock);
    const mac = device('mac');
    await mac.sync(service);
    const before = service.writes.length;
    await mac.sync(service);
    await mac.sync(service);
    expect(service.writes.length).toBe(before);
  });
});
