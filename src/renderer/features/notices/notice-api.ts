// Account notices v1 (docs/hosted-sync/notices.md): what the operator of the
// Hosted service tells signed-in authors. JSON requests from the renderer with
// the Hosted bearer session, like share links and account preferences.
import { hostedAccountFetch } from '../../lib/auth-client';
import { APP_CONFIG } from '../../lib/config';
import { getHostedSessionBinding } from '../../lib/hosted-session-binding';

export interface NoticeText {
  title: string;
  body: string;
}

export interface AccountNotice {
  id: string;
  /** Grows with every notice the service publishes; the unit of the read mark. */
  seq: number;
  /** Addressed to this account alone. */
  personal: boolean;
  /** One entry per language the operator wrote: `zh`, `en`. */
  content: Record<string, NoticeText>;
  /** An `https:` page the notice opens, if any. */
  link: string | null;
  publishedAt: string;
}

export interface AccountNotices {
  /** The active notices addressed to the account, oldest first. */
  notices: AccountNotice[];
  /** Notices up to this `seq` were seen on one of the account's devices. */
  readThrough: number;
  /** How long a client in front waits before reading again. */
  refreshAfterSeconds: number;
}

export interface NoticeTransport {
  read(signal?: AbortSignal): Promise<AccountNotices>;
  markRead(through: number, signal?: AbortSignal): Promise<number>;
}

export class NoticeError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = 'NoticeError';
  }
}

export const NOTICE_REFRESH_DEFAULT_SECONDS = 60;
const NOTICE_REFRESH_MIN_SECONDS = 15;
const NOTICE_REFRESH_MAX_SECONDS = 3600;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const seq = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Only an `https:` URL without credentials is ever opened. */
export function noticeLink(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function noticeContent(value: unknown): Record<string, NoticeText> {
  const content: Record<string, NoticeText> = {};
  if (!isRecord(value)) return content;
  for (const [language, text] of Object.entries(value)) {
    if (!isRecord(text) || typeof text.title !== 'string' || typeof text.body !== 'string') continue;
    const title = text.title.trim();
    if (title) content[language] = { title, body: text.body.trim() };
  }
  return content;
}

/**
 * Reads a response, keeping only what is well formed: a notice without an id,
 * a `seq` or any text is dropped, never shown half.
 */
export function parseAccountNotices(value: unknown): AccountNotices {
  if (!isRecord(value) || !Array.isArray(value.notices)) throw new NoticeError('invalid-response', 0);
  const notices: AccountNotice[] = [];
  for (const entry of value.notices) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id || !seq(entry.seq)) continue;
    const content = noticeContent(entry.content);
    if (!Object.keys(content).length) continue;
    notices.push({
      id: entry.id,
      seq: entry.seq,
      personal: entry.personal === true,
      content,
      link: noticeLink(entry.link),
      publishedAt: typeof entry.publishedAt === 'string' ? entry.publishedAt : '',
    });
  }
  const refresh = typeof value.refreshAfterSeconds === 'number' && Number.isFinite(value.refreshAfterSeconds)
    ? value.refreshAfterSeconds
    : NOTICE_REFRESH_DEFAULT_SECONDS;
  return {
    notices: notices.sort((a, b) => a.seq - b.seq),
    readThrough: seq(value.readThrough) ? value.readThrough : 0,
    refreshAfterSeconds: Math.min(NOTICE_REFRESH_MAX_SECONDS, Math.max(NOTICE_REFRESH_MIN_SECONDS, refresh)),
  };
}

async function request(path: string, init: { body?: unknown; signal?: AbortSignal } = {}): Promise<unknown> {
  const binding = getHostedSessionBinding();
  if (!binding) throw new NoticeError('needs-reauth', 401);
  let response: Response;
  try {
    response = await hostedAccountFetch(`${APP_CONFIG.API_BASE_URL.replace(/\/+$/, '')}/api/account/v1/notices${path}`, {
      method: init.body === undefined ? 'GET' : 'POST',
      credentials: 'omit',
      signal: init.signal,
      headers: {
        Authorization: `Bearer ${binding.token}`,
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch (error) {
    if ((error as { name?: string }).name === 'AbortError') throw error;
    throw new NoticeError('provider-unavailable', 0);
  }
  if (!response.ok) {
    const failure = (await response.json().catch(() => null)) as { code?: unknown } | null;
    throw new NoticeError(typeof failure?.code === 'string' ? failure.code : 'provider-unavailable', response.status);
  }
  return response.json();
}

/** Account notices v1 over the Hosted account session. */
export const hostedNoticeTransport: NoticeTransport = {
  read: async (signal) => parseAccountNotices(await request('', { signal })),
  async markRead(through, signal) {
    const result = await request('/read', { body: { through }, signal });
    if (!isRecord(result) || !seq(result.readThrough)) throw new NoticeError('invalid-response', 0);
    return result.readThrough;
  },
};
