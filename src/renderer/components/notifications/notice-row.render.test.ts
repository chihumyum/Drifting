import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import type { AppNotification } from '../../store/notification-store';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

const notice = (id: string, extra: Partial<AppNotification>): AppNotification => ({
  id, source: 'notice', state: 'completed', title: id, startedAt: 0, updatedAt: 0, read: false, ...extra,
});
// A server render reads a store's initial state, so the rows are given here.
const center = vi.hoisted(() => ({ items: [] as unknown[] }));
vi.mock('../../store/notification-store', () => ({
  useNotificationStore: (select: (state: unknown) => unknown) =>
    select({ items: center.items, remove: () => undefined, clear: () => undefined, setCenterOpen: () => undefined }),
}));

import { NotificationCenter } from './NotificationPill';

it('shows a notice from the service under its own source, with the line breaks of its body', () => {
  center.items = [
    notice('回复', { personal: true, read: true }),
    notice('今晚维护', { detail: '22:00 起同步暂停。\n写作不受影响。', externalUrl: 'https://example.test/status' }),
  ];
  const html = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: ['/'] },
      createElement(NotificationCenter, { now: Date.now(), anchor: { bottom: 40, left: 8 }, containerRef: createRef<HTMLDivElement>() }),
    ),
  );
  const [own, all] = html.split('menu-surface__item notification-row').slice(1);

  // A notice for this account alone is a message; with nothing to open, its row is not a link.
  expect(own).toContain('notifications.notice.personal');
  expect(own).toContain('is-static');
  expect(all).toContain('notifications.notice.source');
  expect(all).toContain('is-unread');
  expect(all).not.toContain('is-static');
  expect(all).toContain('notification-row__detail is-multiline');
  expect(all).toContain('22:00 起同步暂停。\n写作不受影响。');
});
