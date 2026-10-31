import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values && Object.keys(values).length ? `${key}(${Object.values(values).join(',')})` : key,
    i18n: { language: 'zh-CN' },
  }),
}));

import { AgentOnboarding } from './AgentOnboarding';

const root = resolve(import.meta.dirname, '../../../../..');
const read = (relative: string) => readFileSync(resolve(root, relative), 'utf8');

describe('the Agent panel first run', () => {
  it('lists every way to reach a model as an unconnected sidebar cell', () => {
    const html = renderToStaticMarkup(createElement(AgentOnboarding, { view: 'connect', onPick: () => undefined }));
    expect(html).toContain('data-agent-onboarding="connect"');
    expect(html).toContain('agentPanel.onboarding.connect');
    for (const provider of ['openai-codex', 'deepseek', 'anthropic', 'openai']) {
      expect(html).toContain(`data-provider="${provider}"`);
    }
    expect(html.match(/kind-mark--hollow/g)).toHaveLength(4);
    expect(html.match(/agt-onboard__cell glass glass--surface/g)).toHaveLength(4);
    // Rows open on a click; nothing asks for a key before that.
    expect(html).not.toContain('type="password"');
  });

  it('offers three requests for the open book', () => {
    const html = renderToStaticMarkup(createElement(AgentOnboarding, { view: 'suggest', onPick: () => undefined }));
    expect(html).toContain('data-agent-onboarding="suggest"');
    expect(html).toContain('agentPanel.onboarding.try');
    expect(html.match(/agt-onboard__cell--prompt/g)).toHaveLength(3);
    // No book is loaded in this render: the empty-book requests.
    expect(html).toContain('agentPanel.onboarding.prompts.outline');
  });

  it('keeps the design rules: no new material, the open row loses its ring with the pointer', () => {
    const css = read('src/styles/agent-panel.css');
    const block = css.slice(css.indexOf('.agt-onboard {'), css.indexOf('.agt-entity-chip--waiting'));
    expect(block).toContain(".agt-onboard__cell.glass[aria-expanded='true']:not(:hover, :focus-visible)::before");
    expect(block).not.toMatch(/box-shadow|border-left|background:\s*hsl/);
    expect(css).toContain('.agt-entity-chip--waiting {\n  --glass-cc: hsl(var(--accent));');
  });
});
