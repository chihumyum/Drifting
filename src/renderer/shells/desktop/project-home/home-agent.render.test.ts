import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}(${Object.values(values).join(',')})` : key,
    i18n: { language: 'zh-CN' },
  }),
}));

import { EMPTY_PROJECT_CHECKIN, type StoredCheckinCard } from '../../../store/project-checkin-store';
import type { OrganizeOffer } from '../../../store/project-organize-store';
import { HomeAgentFloat, HomeAgentFlow } from './HomeAgent';
import type { HomeAgentModel } from './useHomeAgent';

const checkinCard: StoredCheckinCard = {
  id: 'card-1',
  title: '阿蘅的年龄以哪处为准？',
  detail: '',
  instruction: '问作者阿蘅的年龄。',
  target: null,
  createdAt: '2026-11-05T08:00:00.000Z',
  status: 'open',
};

function agent(organizeOffer: OrganizeOffer | null): HomeAgentModel {
  return {
    record: { ...EMPTY_PROJECT_CHECKIN, cards: [checkinCard] },
    running: false,
    enabled: true,
    projectId: 'p1',
    draft: '',
    setDraft: () => {},
    sending: false,
    send: async () => {},
    busyCard: null,
    cardError: null,
    act: async () => {},
    dismiss: () => {},
    organize: null,
    organizeError: null,
    openOrganize: async () => {},
    dismissOrganize: () => {},
    organizeOffer,
    offerError: null,
    startOrganize: async () => {},
    dismissOrganizeOffer: () => {},
  };
}

const offer: OrganizeOffer = { sinceIso: '2026-11-04T08:00:00.000Z', documents: ['第三章', '第四章'] };

describe('Project Home Agent section', () => {
  it('shows the organize card as the first task card, with no manual check-in', () => {
    const html = renderToStaticMarkup(createElement(HomeAgentFlow, { agent: agent(offer), onOpenMemory: () => {} }));
    expect(html).toContain('data-debug-id="project-home-organize-offer"');
    expect(html).toContain('第三章 · 第四章');
    expect(html.indexOf('organize.offer.title')).toBeLessThan(html.indexOf('阿蘅的年龄以哪处为准？'));
    expect(html).not.toContain('checkNow');
  });

  it('shows no organize card when there is nothing to organize', () => {
    const html = renderToStaticMarkup(createElement(HomeAgentFlow, { agent: agent(null), onOpenMemory: () => {} }));
    expect(html).not.toContain('organize.offer.title');
    expect(html).toContain('阿蘅的年龄以哪处为准？');
  });

  it('floats the organize card as a pill beside the check-in cards', () => {
    const html = renderToStaticMarkup(createElement(HomeAgentFloat, { agent: agent(offer) }));
    expect(html.indexOf('organize.offer.title')).toBeLessThan(html.indexOf('阿蘅的年龄以哪处为准？'));
  });
});
