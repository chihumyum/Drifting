import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN' },
  }),
}));

const runtime = vi.hoisted(() => ({ isMobileShell: false }));
vi.mock('../../platform/runtime', () => ({ getPlatformRuntime: () => runtime }));

const memory = vi.hoisted(() => ({ exists: true }));
vi.mock('../../usecase/useAgentWorkingMemory', () => ({
  useAgentWorkingMemory: (projectId: string) => ({
    snapshot: {
      projectId,
      filename: 'WORKING_MEMORY.md',
      exists: memory.exists,
      contentMd: memory.exists ? '- 第二章加浓雾的描写，对白不动。\n' : '',
      revision: 2,
      approxTokens: memory.exists ? 6820 : 0,
      updatedBy: memory.exists ? 'agent' : null,
      lastCompactedAt: null,
      updatedAt: memory.exists ? '2026-10-29T10:20:00.000Z' : null,
    },
    loading: false,
    refresh: async () => null,
  }),
  saveAgentWorkingMemory: async () => undefined,
  clearAgentWorkingMemory: async () => undefined,
}));

import { AgentWorkingMemoryView } from './AgentWorkingMemoryView';

const root = resolve(import.meta.dirname, '../../../..');
const source = (file: string) => readFileSync(resolve(root, file), 'utf8');
const render = () => renderToStaticMarkup(createElement(AgentWorkingMemoryView, { projectId: 'p' }));

afterEach(() => {
  runtime.isMobileShell = false;
  memory.exists = true;
});

describe('working memory in sand and glass', () => {
  it('reads the document as one still card with a sand reading and text buttons', () => {
    const html = render();
    expect(html).toContain('class="agt-wm agt-wm--glass"');
    expect(html).toContain('class="agt-wm__card glass glass--rest glass--still agent-md"');
    expect(html).toMatch(/<div class="sand-track"><span class="sand-stroke" style="width:9%;--sand-c:hsl\(var\(--ink-3\)\)"><\/span><\/div>/u);
    expect(html).toContain('brush-icon--edit');
    expect(html).toContain('brush-icon--eraser');
    expect(html).toContain('class="agt-wm__text agt-wm__text--danger"');
    // Nothing reads on the accent: no wash header, no accent meter.
    expect(html).not.toContain('agt-wm__header');
    expect(html).not.toContain('agt-wm__meter');
  });

  it('offers a resting button to write the first memory', () => {
    memory.exists = false;
    const html = render();
    expect(html).toContain('empty-state');
    expect(html).toContain('class="agt-btn glass glass--rest glass--small"');
    expect(html).not.toContain('agt-wm__card');
  });

  it('writes on the composer\'s rounded slip with one primary button', () => {
    const view = source('src/renderer/features/agent/AgentWorkingMemoryView.tsx');
    expect(view).toContain('<label className="agt-wm__slip glass glass--rest glass--field">{editor}</label>');
    expect(view).toContain('className="agt-btn glass glass--primary glass--small"');
    const css = source('src/styles/agent-panel.css');
    const slip = css.slice(css.indexOf('.agt-wm__slip {'));
    expect(slip).toContain('border-radius: 16px;');
    expect(slip).toContain('background: hsl(var(--page));');
  });

  it('leaves the paused mobile shell its outlined fallback', () => {
    runtime.isMobileShell = true;
    const html = render();
    expect(html).toContain('class="agt-wm"');
    expect(html).toContain('agt-wm__header');
    expect(html).not.toContain('glass');
    expect(html).not.toContain('brush-icon');
  });
});

describe('history and the config menu as menu rows', () => {
  it('lists conversations as menu rows, the current one medium weight with a still ring', () => {
    const panel = source('src/renderer/features/agent/desktop/DesktopAgentPanel.tsx');
    expect(panel).toContain("'menu-surface__item agt-history__row' +");
    expect(panel).toContain("(c.id === activeConvId ? ' menu-surface__item--active is-current' : '')");
    expect(panel).toContain('<label className="ui-field ui-field--sm glass glass--rest glass--field glass--small">');
    expect(panel).toContain('className="agt-history__running-dot"');
    // No wash marks the current conversation and no outlined rename box.
    expect(panel).not.toContain('hsl(var(--accent) / 0.12)');
    expect(panel).not.toContain("border: '1px solid hsl(var(--accent) / 0.5)'");
  });

  it('builds the desktop config menu from the shared rows, groups parted by the menu hairline', () => {
    const config = source('src/renderer/features/agent/AgentComposerConfig.tsx');
    expect(config).toContain("const sectionClass = glass ? 'menu-surface__section-label' : 'agt-menu__sec';");
    expect(config).toContain("const rowButtonClass = glass ? 'menu-surface__item agt-menu__item' : 'agt-menu__row agt-menu__row--btn';");
    expect(config).toContain("const divider = <div className={glass ? 'menu-surface__divider' : 'agt-menu__divider'} />;");
    // Like every menu, its rows stand 6px in and its words 16px in.
    const css = source('src/styles/agent-panel.css');
    expect(css).toContain('.agt-menu.agt-menu--glass {\n  padding: 6px 0;\n}');
    expect(css).toContain('.agt-menu--glass .agt-menu__row {\n  padding: 6px 16px;');
    expect(config).toContain('className="ui-select glass glass--rest glass--field glass--small agt-menu__effort"');
    expect(config).toContain("? 'menu-surface__item agt-menu__item' + (current ? ' menu-surface__item--active is-current' : '')");
    expect(config).toContain("<span className={glass ? 'agt-mem__pending' : 'agt-mem__kind'}>");
  });

  it('keeps the rows flat: no hover wash, actions as flat icons under the pointer', () => {
    const css = source('src/styles/agent-panel.css');
    const desktop = css.slice(css.indexOf('/* History and the config menu: the shared menu surface\'s rows'));
    expect(desktop.length).toBeGreaterThan(0);
    expect(desktop).not.toContain('--menu-item-hover-bg');
    for (const match of desktop.matchAll(/background:\s*([^;]+);/gu)) {
      expect(['transparent', 'color-mix(in srgb, hsl(var(--page)) 45%, transparent)']).toContain(match[1]);
    }
    expect(desktop).toContain('.agt-mem--pending .agt-mem__acts {\n  opacity: 1;\n}');
    expect(desktop).toContain('font: var(--ui-font-caption, 10.5px)/1 var(--font-mono);');
  });
});
