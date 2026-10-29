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

vi.mock('../../usecase/useAgentMemory', () => ({
  useAgentMemory: () => ({
    memories: [
      { id: 'a', body: '林汐的视角里只叫他“老林”。', status: 'active' },
      { id: 'b', body: '每章结尾不要用景物描写收。', status: 'pending' },
    ],
    add: async () => undefined,
    edit: async () => undefined,
    remove: async () => undefined,
    approve: async () => undefined,
  }),
}));

import { ProjectMemoryEditor } from './ProjectMemoryEditor';

const root = resolve(import.meta.dirname, '../../../..');
const render = () => renderToStaticMarkup(createElement(ProjectMemoryEditor, { projectId: 'p' }));

afterEach(() => {
  runtime.isMobileShell = false;
});

describe('Project Memory in sand and glass', () => {
  it('reads the entries as one still card and writes on the composer\'s slip', () => {
    const html = render();
    expect(html).toContain('class="pmem pmem--glass"');
    expect(html).toContain('<ol class="pmem__list glass glass--rest glass--still">');
    expect(html).toContain('class="pmem__composer glass glass--rest glass--field"');
    // The one primary, faint while the slip is empty.
    expect(html).toMatch(/class="pmem__btn pmem__btn--primary glass glass--primary glass--small" disabled=""/u);
  });

  it('acts on an entry with text buttons and brush icons, delete in the danger ink', () => {
    const html = render();
    expect(html).toContain('brush-icon--check');
    expect(html).toContain('brush-icon--edit');
    expect(html).toContain('brush-icon--trash');
    expect(html).toContain('class="pmem__btn pmem__btn--danger"');
    expect(html.match(/class="pmem__btn[^"]*glass/gu)).toHaveLength(1);
  });

  it('leaves the paused mobile shell without glass or icons', () => {
    runtime.isMobileShell = true;
    const html = render();
    expect(html).toContain('class="pmem"');
    expect(html).not.toContain('glass');
    expect(html).not.toContain('brush-icon');
  });

  it('keeps the desktop rules flat: no wash, no rules between entries, no shadow', () => {
    const css = readFileSync(resolve(root, 'src/styles/project-memory.css'), 'utf8');
    const desktop = css.slice(css.indexOf('/* ── Sand and glass (the desktop)'));
    expect(desktop.length).toBeGreaterThan(0);
    expect(desktop).not.toMatch(/box-shadow/u);
    expect(desktop).toContain('.pmem--glass .pmem__entry + .pmem__entry {\n  border-top: 0;');
    expect(desktop).toContain('color: hsl(var(--destructive));');
    expect(desktop).toContain('border-radius: 16px;');
    for (const match of desktop.matchAll(/background:\s*([^;]+);/gu)) {
      expect(['transparent', 'hsl(var(--page))']).toContain(match[1]);
    }
  });
});
