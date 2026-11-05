import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

import { NotificationCenter } from './NotificationPill';

it('opens on the shelf, where no book is open', () => {
  // No WorkspaceNavigationProvider: the shelf is outside every book's shell.
  const html = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: ['/'] },
      createElement(NotificationCenter, { now: Date.now(), anchor: { bottom: 40, left: 8 }, containerRef: createRef<HTMLDivElement>() }),
    ),
  );

  expect(html).toContain('notification-center');
  expect(html).toContain('notifications.title');
});
