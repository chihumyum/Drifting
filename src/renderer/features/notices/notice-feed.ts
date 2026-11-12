// How account notices become rows of the notification center
// (docs/hosted-sync/notices.md). The center's list lives in memory, so the
// account's read mark stays with the service and the notices an author removed
// are remembered on the device; a notice the service stops offering (withdrawn
// or expired) leaves the list at the next read.
import { useNotificationStore, type AppNotificationEvent } from '../../store/notification-store';
import type { AccountNotice, NoticeText, NoticeTransport } from './notice-api';

export const noticeNotificationId = (noticeId: string): string => `notice:${noticeId}`;

/** The entry for the interface language; otherwise English, then whatever was written. */
export function noticeText(notice: AccountNotice, language: string): NoticeText | null {
  const preferred = language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  return notice.content[preferred] ?? notice.content.en ?? Object.values(notice.content)[0] ?? null;
}

/** The notification center, as far as notices use it. */
export interface NoticeSurface {
  ingest(event: AppNotificationEvent): void;
  remove(id: string): void;
  markRead(id: string): void;
  /** The rows still in the center by id, and whether each has been read. */
  rows(): ReadonlyMap<string, boolean>;
}

/** The app's notification center. */
export const noticeCenterSurface: NoticeSurface = {
  ingest: (event) => useNotificationStore.getState().ingest(event),
  remove: (id) => useNotificationStore.getState().remove(id),
  markRead: (id) => useNotificationStore.getState().markRead(id),
  rows: () => new Map(useNotificationStore.getState().items.map((item) => [item.id, item.read])),
};

export interface NoticeFeedDependencies {
  transport: NoticeTransport;
  surface: NoticeSurface;
  language(): string;
  now(): number;
  /** The notices this account's author removed from the center on this device. */
  loadDismissed(account: string): string[];
  saveDismissed(account: string, noticeIds: string[]): void;
  onError?(error: unknown): void;
}

export class NoticeFeed {
  private account: string | null = null;
  /** Notices that have a row in the center, with their `seq`. */
  private readonly shown = new Map<string, number>();
  private dismissed = new Set<string>();
  /** The account's read mark as the service last reported it. */
  private readThrough = 0;
  /** The newest notice this device has seen read or removed. */
  private seenThrough = 0;
  private sentThrough = 0;
  private sending: Promise<void> | null = null;

  constructor(private readonly dependencies: NoticeFeedDependencies) {}

  /**
   * Reads the account's notices and brings the center in line with them.
   * Returns how many seconds a client in front waits before the next read.
   */
  async refresh(account: string, signal?: AbortSignal): Promise<number> {
    if (account !== this.account) {
      this.reset();
      this.account = account;
      this.dismissed = new Set(this.dependencies.loadDismissed(account));
    }
    const response = await this.dependencies.transport.read(signal);
    // The author signed out or switched accounts while the read was under way.
    if (account !== this.account) return response.refreshAfterSeconds;
    const { surface } = this.dependencies;
    this.noteDismissals();

    const offered = new Map(response.notices.map((notice) => [notice.id, notice]));
    for (const id of [...this.shown.keys()]) {
      if (offered.has(id)) continue;
      this.shown.delete(id);
      surface.remove(noticeNotificationId(id));
    }
    const stillDismissed = [...this.dismissed].filter((id) => offered.has(id));
    if (stillDismissed.length !== this.dismissed.size) {
      this.dismissed = new Set(stillDismissed);
      this.dependencies.saveDismissed(account, stillDismissed);
    }

    this.readThrough = Math.max(this.readThrough, response.readThrough);
    const rows = surface.rows();
    const now = this.dependencies.now();
    for (const notice of response.notices) {
      const rowId = noticeNotificationId(notice.id);
      if (this.shown.has(notice.id)) {
        // Read on another of the account's devices.
        if (notice.seq <= this.readThrough && rows.get(rowId) === false) surface.markRead(rowId);
        continue;
      }
      if (this.dismissed.has(notice.id)) {
        this.seenThrough = Math.max(this.seenThrough, notice.seq);
        continue;
      }
      const text = noticeText(notice, this.dependencies.language());
      if (!text) continue;
      const published = Date.parse(notice.publishedAt);
      this.shown.set(notice.id, notice.seq);
      surface.ingest({
        id: rowId,
        source: 'notice',
        state: 'completed',
        title: text.title,
        detail: text.body || undefined,
        personal: notice.personal,
        externalUrl: notice.link ?? undefined,
        // A service clock ahead of this device must not date a notice in the future.
        at: Number.isFinite(published) ? Math.min(published, now) : now,
        read: notice.seq <= this.readThrough,
      });
    }
    await this.acknowledge(signal);
    return response.refreshAfterSeconds;
  }

  /** The center's rows changed: the author may have read or removed a notice. */
  rowsChanged(): void {
    if (this.account === null) return;
    this.noteDismissals();
    void this.acknowledge();
  }

  /** Signed out, or another account: its notices leave the center. */
  reset(): void {
    const ids = [...this.shown.keys()];
    // Cleared first, so removing the rows is not taken for the author's doing.
    this.shown.clear();
    for (const id of ids) this.dependencies.surface.remove(noticeNotificationId(id));
    this.account = null;
    this.dismissed = new Set();
    this.readThrough = 0;
    this.seenThrough = 0;
    this.sentThrough = 0;
  }

  /** A shown notice whose row is gone was removed by the author: it stays away. */
  private noteDismissals(): void {
    if (this.account === null || !this.shown.size) return;
    const rows = this.dependencies.surface.rows();
    let changed = false;
    for (const [id, seq] of [...this.shown]) {
      if (rows.has(noticeNotificationId(id))) continue;
      this.shown.delete(id);
      this.dismissed.add(id);
      this.seenThrough = Math.max(this.seenThrough, seq);
      changed = true;
    }
    if (changed) this.dependencies.saveDismissed(this.account, [...this.dismissed]);
  }

  /**
   * Raises the account's read mark to the newest notice read here. One request
   * at a time; a failure is tried again at the next read.
   */
  private acknowledge(signal?: AbortSignal): Promise<void> {
    const rows = this.dependencies.surface.rows();
    for (const [id, seq] of this.shown) {
      if (rows.get(noticeNotificationId(id)) === true) this.seenThrough = Math.max(this.seenThrough, seq);
    }
    if (this.sending) return this.sending;
    const through = this.seenThrough;
    if (through <= Math.max(this.readThrough, this.sentThrough)) return Promise.resolve();
    const account = this.account;
    let sent = false;
    this.sending = this.dependencies.transport
      .markRead(through, signal)
      .then((mark) => {
        if (account !== this.account) return;
        this.sentThrough = through;
        this.readThrough = Math.max(this.readThrough, mark);
        sent = true;
      })
      .catch((error: unknown) => {
        if ((error as { name?: string }).name !== 'AbortError') this.dependencies.onError?.(error);
      })
      .finally(() => {
        this.sending = null;
        // A notice read while the request was under way.
        if (sent && this.seenThrough > through) void this.acknowledge();
      });
    return this.sending;
  }
}
