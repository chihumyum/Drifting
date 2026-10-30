import { create } from 'zustand';
import { canUseHostedService } from '../../lib/config';
import { getHostedSessionBinding } from '../../lib/hosted-session-binding';
import { shareLinkApi, type ShareLink } from './share-link-api';
import { readShareDocument, shareDocumentSha256, type ShareTarget } from './share-source';

/**
 * The signed-in account's share links. The service owns them; this is a
 * cache for the share dialog, the publisher and the inbox, refreshed when it
 * is older than the caller allows and replaced on account change.
 */
interface ShareLinkState {
  account: string | null;
  shares: ShareLink[];
  loadedAt: number | null;
  refresh(maxAgeMs?: number): Promise<ShareLink[]>;
  find(target: ShareTarget): ShareLink | undefined;
  upsert(link: ShareLink): void;
  /** Publishes the entity's current copy, creating its link on first use. */
  publish(target: ShareTarget, options?: { commentsEnabled?: boolean }): Promise<ShareLink>;
  setCommentsEnabled(id: string, enabled: boolean): Promise<void>;
  stop(id: string): Promise<void>;
}

/** Hash of the copy each link last received from this device, so an unchanged body is not re-sent. */
const sent = new Map<string, string>();
let loading: { account: string; promise: Promise<ShareLink[]> } | null = null;

export function canShareLinks(): boolean {
  return canUseHostedService() && getHostedSessionBinding() !== null;
}

const sameTarget = (link: ShareLink, target: ShareTarget) =>
  link.projectId === target.projectId && link.entityKind === target.entityKind && link.entityId === target.entityId;

export const useShareLinkStore = create<ShareLinkState>((set, get) => ({
  account: null,
  shares: [],
  loadedAt: null,
  async refresh(maxAgeMs = 0) {
    const account = getHostedSessionBinding()?.accountSubject ?? null;
    if (!account || !canUseHostedService()) {
      if (get().account !== null) set({ account: null, shares: [], loadedAt: null });
      return [];
    }
    const state = get();
    if (state.account === account && state.loadedAt !== null && Date.now() - state.loadedAt <= maxAgeMs) return state.shares;
    if (loading?.account === account) return loading.promise;
    const promise = shareLinkApi.list().then(shares => {
      if (getHostedSessionBinding()?.accountSubject === account) set({ account, shares, loadedAt: Date.now() });
      return shares;
    }).finally(() => { if (loading?.promise === promise) loading = null; });
    loading = { account, promise };
    return promise;
  },
  find(target) {
    const account = getHostedSessionBinding()?.accountSubject ?? null;
    const state = get();
    return state.account === account ? state.shares.find(link => sameTarget(link, target)) : undefined;
  },
  upsert(link) {
    const account = getHostedSessionBinding()?.accountSubject ?? null;
    set(state => state.account === account
      ? { shares: [link, ...state.shares.filter(item => item.id !== link.id)] }
      : { account, shares: [link], loadedAt: null });
  },
  async publish(target, options = {}) {
    const document = await readShareDocument(target);
    if (!document) throw new Error('The shared entity is no longer available');
    const sha = await shareDocumentSha256(document);
    const link = await shareLinkApi.publish({ ...target, document, ...options });
    sent.set(link.id, sha);
    get().upsert(link);
    return link;
  },
  async setCommentsEnabled(id, enabled) {
    get().upsert(await shareLinkApi.setCommentsEnabled(id, enabled));
  },
  async stop(id) {
    await shareLinkApi.remove(id);
    sent.delete(id);
    set(state => ({ shares: state.shares.filter(link => link.id !== id) }));
  },
}));

/**
 * Re-sends a link's copy when the entity's prose or title changed since the
 * service last stored it. Returns whether anything was published.
 */
export async function republishShareLink(link: ShareLink): Promise<boolean> {
  const target = { projectId: link.projectId, entityKind: link.entityKind, entityId: link.entityId };
  const document = await readShareDocument(target);
  if (!document) return false;
  const sha = await shareDocumentSha256(document);
  if (sha === link.documentSha256 || sent.get(link.id) === sha) return false;
  const updated = await shareLinkApi.publish({ ...target, document });
  sent.set(updated.id, sha);
  useShareLinkStore.getState().upsert(updated);
  return true;
}
