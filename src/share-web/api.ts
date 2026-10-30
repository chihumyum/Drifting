// The reader page talks to its own origin: Caddy serves it beside the Hosted
// API in production, and the development server proxies /api. The account
// session is the service's HttpOnly cookie; the page never holds a token.
import type { ShareCommentAnchor, ShareDocument } from '../shared/share-document';

export interface ReaderComment {
  id: string;
  authorName: string;
  body: string;
  anchor: ShareCommentAnchor;
  status: 'open' | 'resolved';
  createdAt: string;
  mine: boolean;
}

export interface ReaderPage {
  share: {
    title: string;
    kind: ShareDocument['kind'];
    revision: number;
    publishedAt: string;
    commentsEnabled: boolean;
    ownerName: string;
  };
  document?: ShareDocument;
  comments: ReaderComment[];
  viewer: { name: string } | null;
}

export class ReaderError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = 'ReaderError';
  }
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      credentials: 'same-origin',
      headers: init.body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch {
    throw new ReaderError('OFFLINE', 0);
  }
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const code = typeof body?.code === 'string' ? body.code : `HTTP_${response.status}`;
    throw new ReaderError(code, response.status);
  }
  return body as T;
}

const link = (token: string) => `/api/share/v1/links/${encodeURIComponent(token)}`;

export const readerApi = {
  page: (token: string, revision?: number) =>
    call<ReaderPage>(`${link(token)}${revision ? `?revision=${revision}` : ''}`),
  comment: (token: string, body: string, anchor: ShareCommentAnchor) =>
    call<ReaderComment>(`${link(token)}/comments`, { body: { body, anchor } }),
  withdraw: (token: string, id: string) =>
    call<{ status: 'withdrawn' }>(`${link(token)}/comments/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

/** Drifting account sign-in through the service's Better Auth endpoints. */
export const accountApi = {
  signIn: (email: string, password: string) => call('/api/auth/sign-in/email', { body: { email, password } }),
  signUp: (name: string, email: string, password: string) => call('/api/auth/sign-up/email', { body: { name, email, password } }),
  sendCode: (email: string) => call('/api/auth/email-otp/send-verification-otp', { body: { email, type: 'email-verification' } }),
  verify: (email: string, otp: string) => call('/api/auth/email-otp/verify-email', { body: { email, otp } }),
  signOut: () => call('/api/auth/sign-out', { body: {} }),
};
