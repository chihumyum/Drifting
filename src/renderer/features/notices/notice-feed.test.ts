import { afterEach, describe, expect, it } from 'vitest';
import { useNotificationStore } from '../../store/notification-store';
import type { AccountNotice, NoticeText, NoticeTransport } from './notice-api';
import { NoticeFeed, noticeCenterSurface, noticeNotificationId, noticeText } from './notice-feed';

const NOW = Date.parse('2026-11-13T08:00:00.000Z');
const zh = (title: string): NoticeText => ({ title, body: `${title}的正文。` });
const en = (title: string): NoticeText => ({ title, body: `Body of ${title}.` });

/** An in-memory account notices v1 service with the real read-mark rule. */
function service() {
  type Stored = AccountNotice & { to: string | null; withdrawn: boolean };
  const state = {
    account: 'author',
    notices: [] as Stored[],
    marks: new Map<string, number>(),
    reads: 0,
    marked: [] as number[],
    offline: false,
  };
  const transport: NoticeTransport = {
    async read() {
      state.reads += 1;
      const account = state.account;
      return {
        notices: state.notices
          .filter((notice) => !notice.withdrawn && (notice.to === null || notice.to === account))
          .map(({ to: _to, withdrawn: _withdrawn, ...notice }) => notice),
        readThrough: state.marks.get(account) ?? 0,
        refreshAfterSeconds: 60,
      };
    },
    async markRead(through) {
      if (state.offline) throw new Error('offline');
      state.marked.push(through);
      const mark = Math.max(state.marks.get(state.account) ?? 0, Math.min(through, state.notices.length));
      state.marks.set(state.account, mark);
      return mark;
    },
  };
  const publish = (content: Record<string, NoticeText>, extra: Partial<Stored> = {}) => {
    const notice: Stored = {
      id: `n${state.notices.length + 1}`,
      seq: state.notices.length + 1,
      personal: Boolean(extra.to),
      content,
      link: null,
      publishedAt: '2026-11-13T07:00:00.000Z',
      to: null,
      withdrawn: false,
      ...extra,
    };
    state.notices.push(notice);
    return notice;
  };
  return { state, transport, publish };
}

/** One device: its feed, wired to the notification center as the runtime wires it. */
function device(remote: ReturnType<typeof service>, language = 'zh-CN') {
  const dismissed = new Map<string, string[]>();
  const errors: unknown[] = [];
  const feed = new NoticeFeed({
    transport: remote.transport,
    surface: noticeCenterSurface,
    language: () => language,
    now: () => NOW,
    loadDismissed: (account) => dismissed.get(account) ?? [],
    saveDismissed: (account, ids) => void dismissed.set(account, ids),
    onError: (error) => void errors.push(error),
  });
  const stop = useNotificationStore.subscribe((state, previous) => {
    if (state.items !== previous.items) feed.rowsChanged();
  });
  stops.push(stop);
  return { feed, dismissed, errors, refresh: () => feed.refresh(remote.state.account) };
}

const stops: (() => void)[] = [];
const rows = () =>
  useNotificationStore.getState().items.map((item) => ({ id: item.id, title: item.title, read: item.read }));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const openCenter = async () => {
  useNotificationStore.getState().setCenterOpen(true);
  await settle();
};

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  useNotificationStore.setState({ items: [], centerOpen: false, centerOwner: null });
});

describe('notice text', () => {
  const notice = (content: Record<string, NoticeText>): AccountNotice =>
    ({ id: 'n', seq: 1, personal: false, content, link: null, publishedAt: '' });

  it('follows the interface language, then English, then whatever was written', () => {
    const both = notice({ zh: zh('维护'), en: en('Maintenance') });
    expect(noticeText(both, 'zh-CN')?.title).toBe('维护');
    expect(noticeText(both, 'zh-TW')?.title).toBe('维护');
    expect(noticeText(both, 'en')?.title).toBe('Maintenance');
    expect(noticeText(both, 'ja')?.title).toBe('Maintenance');
    expect(noticeText(notice({ en: en('Maintenance') }), 'zh-CN')?.title).toBe('Maintenance');
    expect(noticeText(notice({ zh: zh('回复') }), 'fr')?.title).toBe('回复');
    expect(noticeText(notice({}), 'en')).toBeNull();
  });
});

describe('account notices in the notification center', () => {
  it('shows each notice once, unread until the account has seen it', async () => {
    const remote = service();
    remote.publish({ zh: zh('今晚维护'), en: en('Maintenance tonight') }, { link: 'https://example.test/status' });
    remote.publish({ zh: zh('回复') }, { to: 'author' });
    remote.state.marks.set('author', 1);
    const { refresh } = device(remote);

    expect(await refresh()).toBe(60);
    const items = useNotificationStore.getState().items;
    expect(items.map(({ id, source, state, title, detail, read, personal, externalUrl, updatedAt }) =>
      ({ id, source, state, title, detail, read, personal, externalUrl, updatedAt }))).toEqual([
      { id: 'notice:n2', source: 'notice', state: 'completed', title: '回复', detail: '回复的正文。', read: false,
        personal: true, externalUrl: undefined, updatedAt: Date.parse('2026-11-13T07:00:00.000Z') },
      { id: 'notice:n1', source: 'notice', state: 'completed', title: '今晚维护', detail: '今晚维护的正文。', read: true,
        personal: false, externalUrl: 'https://example.test/status', updatedAt: Date.parse('2026-11-13T07:00:00.000Z') },
    ]);

    // Reading again changes nothing: no row moves, none turns unread again.
    await refresh();
    expect(useNotificationStore.getState().items).toEqual(items);
    expect(remote.state.marked).toEqual([]);
  });

  it('speaks the interface language and never dates a notice in the future', async () => {
    const remote = service();
    remote.publish({ zh: zh('今晚维护'), en: en('Maintenance tonight') }, { publishedAt: '2026-11-13T09:00:00.000Z' });
    const { refresh } = device(remote, 'de');
    await refresh();
    const [row] = useNotificationStore.getState().items;
    expect({ title: row!.title, detail: row!.detail, updatedAt: row!.updatedAt })
      .toEqual({ title: 'Maintenance tonight', detail: 'Body of Maintenance tonight.', updatedAt: NOW });
  });

  it('raises the account read mark once when the center opens', async () => {
    const remote = service();
    remote.publish({ zh: zh('一') });
    remote.publish({ zh: zh('二') });
    const { refresh } = device(remote);
    await refresh();
    expect(remote.state.marked).toEqual([]);

    await openCenter();
    expect(remote.state.marked).toEqual([2]);
    expect(remote.state.marks.get('author')).toBe(2);
    await refresh();
    useNotificationStore.getState().setCenterOpen(false);
    await settle();
    expect(remote.state.marked).toEqual([2]);

    // A later notice arrives unread and is acknowledged on its own.
    remote.publish({ zh: zh('三') });
    await refresh();
    expect(rows()[0]).toEqual({ id: 'notice:n3', title: '三', read: false });
    await openCenter();
    expect(remote.state.marked).toEqual([2, 3]);
  });

  it('marks a notice read here once another device has read it, without moving it', async () => {
    const remote = service();
    remote.publish({ zh: zh('一') });
    const { refresh } = device(remote);
    await refresh();
    useNotificationStore.getState().ingest({ id: 'other', source: 'app-update', state: 'completed', title: '别的通知', at: NOW });
    remote.state.marks.set('author', 1);
    await refresh();
    expect(rows()).toEqual([
      { id: 'other', title: '别的通知', read: false },
      { id: 'notice:n1', title: '一', read: true },
    ]);
    expect(remote.state.marked).toEqual([]);
  });

  it('retries a read mark that could not be sent', async () => {
    const remote = service();
    remote.publish({ zh: zh('一') });
    const { refresh, errors } = device(remote);
    await refresh();
    remote.state.offline = true;
    await openCenter();
    expect(errors).toHaveLength(1);
    expect(remote.state.marks.get('author')).toBeUndefined();
    remote.state.offline = false;
    await refresh();
    expect(remote.state.marked).toEqual([1]);
  });

  it('drops a notice the service withdrew, and does not take that for the author removing it', async () => {
    const remote = service();
    const first = remote.publish({ zh: zh('一') });
    remote.publish({ zh: zh('二') });
    const { refresh, dismissed } = device(remote);
    await refresh();
    first.withdrawn = true;
    await refresh();
    expect(rows().map((row) => row.id)).toEqual(['notice:n2']);
    expect(dismissed.size).toBe(0);
  });

  it('keeps away a notice the author removed, on this device, until the service stops offering it', async () => {
    const remote = service();
    const first = remote.publish({ zh: zh('一') });
    remote.publish({ zh: zh('二') });
    const mac = device(remote);
    await mac.refresh();
    await openCenter();
    useNotificationStore.getState().remove(noticeNotificationId('n1'));
    await settle();
    expect(mac.dismissed.get('author')).toEqual(['n1']);
    await mac.refresh();
    expect(rows().map((row) => row.id)).toEqual(['notice:n2']);

    // After a restart the center is empty; the removed notice still stays away.
    for (const stop of stops.splice(0)) stop();
    useNotificationStore.setState({ items: [] });
    const restarted = new NoticeFeed({
      transport: remote.transport,
      surface: noticeCenterSurface,
      language: () => 'zh-CN',
      now: () => NOW,
      loadDismissed: (account) => mac.dismissed.get(account) ?? [],
      saveDismissed: (account, ids) => void mac.dismissed.set(account, ids),
    });
    await restarted.refresh('author');
    expect(rows()).toEqual([{ id: 'notice:n2', title: '二', read: true }]);

    first.withdrawn = true;
    await restarted.refresh('author');
    expect(mac.dismissed.get('author')).toEqual([]);
  });

  it('acknowledges a notice removed before its read mark reached the service', async () => {
    const remote = service();
    remote.publish({ zh: zh('一') });
    const { refresh } = device(remote);
    await refresh();
    remote.state.offline = true;
    useNotificationStore.getState().clear();
    await settle();
    expect(rows()).toEqual([]);
    remote.state.offline = false;
    await refresh();
    expect(rows()).toEqual([]);
    expect(remote.state.marks.get('author')).toBe(1);
  });

  it('shows another account its own notices and takes the previous account\'s away', async () => {
    const remote = service();
    remote.publish({ zh: zh('给大家') });
    remote.publish({ zh: zh('给作者') }, { to: 'author' });
    remote.publish({ zh: zh('给读者') }, { to: 'reader' });
    const { feed, refresh, dismissed } = device(remote);
    await refresh();
    expect(rows().map((row) => row.title)).toEqual(['给作者', '给大家']);

    remote.state.account = 'reader';
    await refresh();
    expect(rows().map((row) => row.title)).toEqual(['给读者', '给大家']);
    expect(rows().every((row) => !row.read)).toBe(true);

    // Signing out takes the notices away without recording them as removed.
    feed.reset();
    await settle();
    expect(rows()).toEqual([]);
    expect(dismissed.size).toBe(0);
    expect(remote.state.marked).toEqual([]);
  });

  it('leaves other notifications alone', async () => {
    const remote = service();
    remote.publish({ zh: zh('一') });
    const { feed, refresh } = device(remote);
    useNotificationStore.getState().ingest({ id: 'other', source: 'app-update', state: 'completed', title: '别的通知', at: NOW });
    await refresh();
    remote.state.notices[0]!.withdrawn = true;
    await refresh();
    feed.reset();
    expect(rows()).toEqual([{ id: 'other', title: '别的通知', read: false }]);
  });
});
