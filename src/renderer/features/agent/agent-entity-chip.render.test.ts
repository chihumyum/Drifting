import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN' },
  }),
}));

import { EntityLinkChip } from './AgentMessageViews';

const chip = (op: 'create' | 'write') =>
  renderToStaticMarkup(createElement(EntityLinkChip, {
    refItem: { entityType: 'element', id: 'element-1', op },
    onOpen: () => {},
  }));

describe('the entity chips under an Agent reply', () => {
  it('names the entity alone, with no created or edited suffix', () => {
    for (const op of ['create', 'write'] as const) {
      const html = chip(op);
      expect(html).not.toContain('agt-entity-chip__op');
      expect(html).not.toContain('agentPanel.entity');
    }
  });
});
