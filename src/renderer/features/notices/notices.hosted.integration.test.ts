import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

import { useNotificationStore } from '../../store/notification-store';
import { hostedNoticeTransport } from './notice-api';
import { NoticeFeed, noticeCenterSurface, noticeNotificationId } from './notice-feed';

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${origin}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin!, ...headers }, body: JSON.stringify(body),
    });
    if (response.status === 429 && attempt < 2) {
      const retry = Number(response.headers.get('x-retry-after') ?? response.headers.get('retry-after') ?? 60);
      await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.min(60, Number.isFinite(retry) ? retry : 60)) * 1000 + 250));
      continue;
    }
    return response;
  }
}

/** A synthetic verified account on the local disposable service, through Mailpit. */
async function createAccount() {
  const email = `notices-client-${randomUUID()}@example.test`;
  const password = randomUUID();
  const auth = async (endpoint: string, body: unknown) => {
    const response = await post(`/api/auth/${endpoint}`, body);
    expect(response.status, endpoint).toBe(200);
    return response;
  };
  await auth('sign-up/email', { email, password, name: 'Synthetic author' });
  await auth('email-otp/send-verification-otp', { email, type: 'email-verification' });
  const mail = process.env.HOSTED_TEST_MAIL_ORIGIN ?? 'http://localhost:8025';
  const listing = await (await fetch(`${mail}/api/v1/messages`)).json() as { messages: { ID: string; To: { Address: string }[] }[] };
  const message = listing.messages.find(item => item.To.some(to => to.Address === email))!;
  const text = (await (await fetch(`${mail}/api/v1/message/${message.ID}`)).json() as { Text: string }).Text;
  await auth('email-otp/verify-email', { email, otp: text.match(/\b\d{6}\b/)![0] });
  const signIn = async () => {
    const response = await auth('sign-in/email', { email, password });
    const user = (await response.json() as { user: { id: string } }).user;
    return { accountSubject: user.id, token: response.headers.get('set-auth-token')! };
  };
  return { email, signIn };
}

/**
 * The operator console of the local service. Its account is the synthetic one
 * the service's own acceptance creates and lists in OPERATOR_EMAILS.
 */
async function operatorConsole() {
  const email = process.env.HOSTED_TEST_OPERATOR_EMAIL;
  const password = process.env.HOSTED_TEST_OPERATOR_PASSWORD;
  expect(email && password, 'Set HOSTED_TEST_OPERATOR_EMAIL and HOSTED_TEST_OPERATOR_PASSWORD to the local service\'s operator').toBeTruthy();
  const signIn = await post('/api/auth/sign-in/email', { email, password });
  expect(signIn.status).toBe(200);
  const Cookie = signIn.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const published: string[] = [];
  return {
    async publish(body: Record<string, unknown>) {
      const response = await post('/api/admin/v1/notices', { expiresInDays: 1, ...body }, { Cookie });
      expect(response.status).toBe(201);
      const notice = await response.json() as { id: string; seq: number };
      published.push(notice.id);
      return notice;
    },
    async withdraw(id: string) {
      expect((await post(`/api/admin/v1/notices/${id}/withdraw`, {}, { Cookie })).status).toBe(200);
    },
    async withdrawAll() {
      for (const id of published.splice(0)) await post(`/api/admin/v1/notices/${id}/withdraw`, {}, { Cookie });
    },
  };
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  useNotificationStore.setState({ items: [], centerOpen: false, centerOwner: null });
});

describe.skipIf(!origin)('account notices against the Hosted service', () => {
  it('shows what the operator publishes, raises the account read mark and drops what is withdrawn', async () => {
    const account = await createAccount();
    const operator = await operatorConsole();
    cleanups.push(() => operator.withdrawAll());
    const tag = randomUUID().slice(0, 8);
    const everyone = await operator.publish({
      audience: 'all',
      content: {
        zh: { title: `今晚维护 ${tag}`, body: '22:00 起同步暂停约十分钟。\n写作不受影响。' },
        en: { title: `Maintenance tonight ${tag}`, body: 'Sync pauses for about ten minutes from 22:00.' },
      },
      link: 'https://example.test/status',
    });
    const personal = await operator.publish({
      audience: 'account', email: account.email, content: { zh: { title: `回复 ${tag}`, body: '你说的问题已经修好。' } },
    });

    session.binding = await account.signIn();
    const feed = new NoticeFeed({
      transport: hostedNoticeTransport,
      surface: noticeCenterSurface,
      language: () => 'en',
      now: () => Date.now(),
      loadDismissed: () => [],
      saveDismissed: () => undefined,
    });
    cleanups.push(useNotificationStore.subscribe((state, previous) => {
      if (state.items !== previous.items) feed.rowsChanged();
    }));
    const mine = () => useNotificationStore.getState().items
      .filter(item => [everyone.id, personal.id].map(noticeNotificationId).includes(item.id))
      .map(({ id, title, detail, read, personal: own, externalUrl }) => ({ id, title, detail, read, own, externalUrl }));

    expect(await feed.refresh(session.binding.accountSubject)).toBe(60);
    expect(mine()).toEqual([
      // Written only in Chinese, so shown in Chinese.
      { id: noticeNotificationId(personal.id), title: `回复 ${tag}`, detail: '你说的问题已经修好。', read: false, own: true, externalUrl: undefined },
      { id: noticeNotificationId(everyone.id), title: `Maintenance tonight ${tag}`, detail: 'Sync pauses for about ten minutes from 22:00.',
        read: false, own: false, externalUrl: 'https://example.test/status' },
    ]);

    // Opening the center on this device reads them for the whole account.
    useNotificationStore.getState().setCenterOpen(true);
    const otherDevice = await account.signIn();
    await vi.waitFor(async () => {
      session.binding = otherDevice;
      expect((await hostedNoticeTransport.read()).readThrough).toBe(personal.seq);
    }, { timeout: 10_000, interval: 500 });

    await operator.withdraw(everyone.id);
    await feed.refresh(session.binding!.accountSubject);
    expect(mine().map(row => row.id)).toEqual([noticeNotificationId(personal.id)]);
  }, 180_000);
});
