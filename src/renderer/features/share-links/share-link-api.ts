// Share link v1 owner API (docs/share-links.md). JSON requests from the
// renderer with the Hosted bearer session, like the account client; the
// immutable sync objects keep their separate native transport.
import { hostedAccountFetch } from '../../lib/auth-client';
import { APP_CONFIG } from '../../lib/config';
import { getHostedSessionBinding } from '../../lib/hosted-session-binding';
import type { ShareCommentAnchor, ShareDocument } from '../../../shared/share-document';

/** The entity kinds a link can share: every prose entity (lib/yjs-doc-id). */
export type ShareEntityKind = 'node' | 'element' | 'storyline' | 'category';

export interface ShareLink {
  id: string;
  token: string;
  projectId: string;
  entityKind: ShareEntityKind;
  entityId: string;
  title: string;
  revision: number;
  documentSha256: string;
  commentsEnabled: boolean;
  publishedAt: string;
  createdAt: string;
}

export interface ShareInboxComment {
  id: string;
  shareId: string;
  projectId: string;
  entityKind: ShareEntityKind;
  entityId: string;
  authorName: string;
  body: string;
  anchor: ShareCommentAnchor;
  status: 'open' | 'resolved';
  createdAt: string;
}

export interface ShareInbox {
  comments: ShareInboxComment[];
  withdrawals: { id: string; shareId: string; projectId: string }[];
  imported: { id: string; projectId: string; status: 'open' | 'resolved' }[];
}

export class ShareLinkError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = 'ShareLinkError';
  }
}

export function shareLinkUrl(token: string): string {
  return `${APP_CONFIG.SHARE_WEB_ORIGIN.replace(/\/+$/, '')}/s/${encodeURIComponent(token)}`;
}

async function request<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const binding = getHostedSessionBinding();
  if (!binding) throw new ShareLinkError('needs-reauth', 401);
  let response: Response;
  try {
    response = await hostedAccountFetch(`${APP_CONFIG.API_BASE_URL.replace(/\/+$/, '')}/api/share/v1/${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
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
    throw new ShareLinkError('provider-unavailable', 0);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { code?: unknown } | null;
    const code = response.status === 401 ? 'needs-reauth' : typeof body?.code === 'string' ? body.code : 'provider-unavailable';
    throw new ShareLinkError(code, response.status);
  }
  return await response.json() as T;
}

export const shareLinkApi = {
  list: (signal?: AbortSignal) => request<{ shares: ShareLink[] }>('shares', { signal }).then(result => result.shares),
  publish: (input: { projectId: string; entityKind: ShareEntityKind; entityId: string; document: ShareDocument; commentsEnabled?: boolean }) =>
    request<ShareLink>('shares', { body: input }),
  setCommentsEnabled: (id: string, commentsEnabled: boolean) =>
    request<ShareLink>(`shares/${encodeURIComponent(id)}`, { method: 'PUT', body: { commentsEnabled } }),
  remove: (id: string) => request<{ status: 'deleted' }>(`shares/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  inbox: (signal?: AbortSignal) => request<ShareInbox>('inbox', { signal }),
  acknowledge: (imported: string[], withdrawn: string[]) =>
    request<{ status: 'acknowledged' }>('inbox/ack', { body: { imported, withdrawn } }),
  setStatuses: (updates: { id: string; status: 'open' | 'resolved' }[]) =>
    request<{ status: 'updated' }>('comment-status', { body: { updates } }),
};
