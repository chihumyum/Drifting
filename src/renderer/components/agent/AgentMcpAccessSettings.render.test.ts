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
vi.mock('../../platform/runtime', () => ({
  getPlatformRuntime: () => ({ isMacDesktop: true, isWindowsDesktop: false }),
}));
vi.mock('../../platform', () => ({ platform: { mcpServer: { list: async () => [] } } }));

const { AgentMcpAccessSettings } = await import('./AgentMcpAccessSettings');

describe('External agent access settings', () => {
  it('offers each client a Connect button and no permission to choose', () => {
    const html = renderToStaticMarkup(createElement(AgentMcpAccessSettings, { open: true }));
    for (const client of ['Codex', 'Claude Code', 'Antigravity'])
      expect(html).toContain(`settings.agent.mcpAccess.connect(${client})`);
    expect(html).not.toMatch(/permission|<select|role="combobox"|role="radiogroup"/i);
  });
});
