import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

const origin = process.env.HOSTED_TEST_ORIGIN;
const session = vi.hoisted(() => ({ binding: null as { accountSubject: string; token: string } | null }));

vi.mock('../../lib/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/config')>();
  const service = process.env.HOSTED_TEST_ORIGIN ?? 'http://localhost:3000';
  return {
    ...actual,
    APP_CONFIG: { ...actual.APP_CONFIG, LOCAL_ONLY_MODE: false, API_BASE_URL: service },
    canUseHostedService: () => true,
  };
});
vi.mock('../../lib/hosted-session-binding', () => ({
  getHostedSessionBinding: () => session.binding,
  bindHostedSession: () => undefined,
  clearHostedSessionBinding: () => undefined,
}));

import {
  emptyPreferenceLedger,
  recordPreferenceChanges,
  syncPreferences,
  type PreferenceSurface,
} from './preference-sync-core';
import { hostedPreferenceTransport } from './preference-sync-runtime';

/** A synthetic verified account on the local disposable service, through Mailpit. */
async function createAccount() {
  const email = `preferences-client-${randomUUID()}@example.test`;
  const password = randomUUID();
  const post = async (endpoint: string, body: unknown) => {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${origin}/api/auth/${endpoint}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin! }, body: JSON.stringify(body),
      });
      if (response.status === 429 && attempt < 2) {
        const retry = Number(response.headers.get('retry-after') ?? 60);
        await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.min(60, Number.isFinite(retry) ? retry : 60)) * 1000 + 250));
        continue;
      }
      expect(response.status, endpoint).toBe(200);
      return response;
    }
  };
  await post('sign-up/email', { email, password, name: 'Synthetic author' });
  await post('email-otp/send-verification-otp', { email, type: 'email-verification' });
  const mail = process.env.HOSTED_TEST_MAIL_ORIGIN ?? 'http://localhost:8025';
  const listing = await (await fetch(`${mail}/api/v1/messages`)).json() as { messages: { ID: string; To: { Address: string }[] }[] };
  const message = listing.messages.find(item => item.To.some(to => to.Address === email))!;
  const text = (await (await fetch(`${mail}/api/v1/message/${message.ID}`)).json() as { Text: string }).Text;
  await post('email-otp/verify-email', { email, otp: text.match(/\b\d{6}\b/)![0] });
  const signIn = async () => {
    const response = await post('sign-in/email', { email, password });
    const user = (await response.json() as { user: { id: string } }).user;
    return { accountSubject: user.id, token: response.headers.get('set-auth-token')! };
  };
  return { signIn };
}

const KEYS = ['themeMode', 'bodyFontSize', 'entityLinkKindColors'] as const;

/** One Mac: its settings, its ledger and its own session of the account. */
function device(binding: { accountSubject: string; token: string }) {
  const state: Record<string, unknown> = { themeMode: 'light', bodyFontSize: 17, entityLinkKindColors: { element: '#3a6ea5' } };
  const ledger = emptyPreferenceLedger();
  const snapshot = () => new Map(KEYS.map(key => [key, JSON.stringify(state[key])]));
  const surface: PreferenceSurface = {
    keys: KEYS,
    read: key => state[key],
    apply: (key, value) => { state[key] = value; return true; },
  };
  return {
    state,
    ledger,
    change(key: (typeof KEYS)[number], value: unknown, at = new Date().toISOString()) {
      const before = snapshot();
      state[key] = value;
      recordPreferenceChanges(ledger, before, snapshot(), at);
    },
    async sync() {
      session.binding = binding;
      await syncPreferences({
        accountId: binding.accountSubject, surface, ledger, transport: hostedPreferenceTransport,
        signal: new AbortController().signal,
      });
    },
  };
}

describe.skipIf(!origin)('account preferences against the Hosted service', () => {
  it('two devices of one account converge on the latest change of each setting', async () => {
    const account = await createAccount();
    const mac = device(await account.signIn());
    const air = device(await account.signIn());
    // The first device fills the account; the second adopts it.
    mac.change('themeMode', 'dark');
    await mac.sync();
    await air.sync();
    expect(air.state.themeMode).toBe('dark');
    // Both change while apart; the later change of a setting wins on both.
    const earlier = new Date(Date.now() - 60_000).toISOString();
    air.change('bodyFontSize', 21);
    mac.change('bodyFontSize', 19, earlier);
    mac.change('entityLinkKindColors', { element: '#aa3355' });
    await air.sync();
    await mac.sync();
    await air.sync();
    for (const side of [mac, air])
      expect(side.state).toEqual({ themeMode: 'dark', bodyFontSize: 21, entityLinkKindColors: { element: '#aa3355' } });
    expect(Object.values(mac.ledger.entries).every(entry => !entry.pending)).toBe(true);
    expect(Object.values(air.ledger.entries).every(entry => !entry.pending)).toBe(true);
  }, 120_000);

  it('another account neither sees nor overwrites these settings', async () => {
    const first = device(await (await createAccount()).signIn());
    const second = device(await (await createAccount()).signIn());
    first.change('themeMode', 'system');
    await first.sync();
    await second.sync();
    expect(second.state.themeMode).toBe('light');
    second.change('themeMode', 'dark');
    await second.sync();
    await first.sync();
    expect(first.state.themeMode).toBe('system');
  }, 120_000);
});
