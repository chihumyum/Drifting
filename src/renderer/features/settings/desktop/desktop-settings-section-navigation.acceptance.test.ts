import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  filterSettingsNavigation,
  sameSettingsNavigation,
  settingsItemAtTop,
  settingsTargetScrollTop,
  type SettingsNavigationSection,
  type SettingsNavigationIndex,
} from './settings-section-navigation';

const root = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('desktop settings section navigation', () => {
  const elementAt = (top: number) => ({ getBoundingClientRect: () => ({ top }) }) as HTMLElement;
  const section = (id: string, label: string, top = 0, searchText = ''): SettingsNavigationSection => ({ id, label, element: elementAt(top), searchText });

  it('finds translated subsections while retaining their parent and filters unrelated children', () => {
    const items = [{ id: 'editor', label: '编辑器' }, { id: 'agent', label: 'Agent' }, { id: 'trash', label: '回收站' }];
    const sections = {
      editor: { searchText: '', sections: [section('preview', '预览'), section('type', '排版')] },
      agent: { searchText: '', sections: [section('memory', 'Memory')] },
    };
    expect(filterSettingsNavigation(items, sections, ' 排版 ')).toEqual([{ ...items[0], sections: [sections.editor.sections[1]] }]);
    expect(filterSettingsNavigation(items, sections, 'EDITOR')[0].sections).toEqual(sections.editor.sections);
    expect(filterSettingsNavigation(items, sections, 'mEMory')[0].id).toBe('agent');
    expect(filterSettingsNavigation(items, sections, '')).toHaveLength(3);
    expect(filterSettingsNavigation(items, sections, 'missing')).toEqual([]);
  });

  it('finds body-only matches in the right group and ungrouped panel descriptions', () => {
    const items = [{ id: 'editor', label: '编辑器' }, { id: 'privacy', label: '隐私' }];
    const typesetting = section('type', '排版', 0, '字号 调整正文大小');
    const flow = section('flow', '写作', 0, '自动保存 每隔 3 秒');
    const index: SettingsNavigationIndex = {
      editor: { searchText: '面板简介 字号 调整正文大小 自动保存 每隔 3 秒', sections: [typesetting, flow] },
      privacy: { searchText: 'api key 留在本机', sections: [] },
    };
    expect(filterSettingsNavigation(items, index, '正文大小')).toEqual([{ ...items[0], sections: [typesetting] }]);
    expect(filterSettingsNavigation(items, index, '每隔\n  3 秒')[0].sections).toEqual([flow]);
    expect(filterSettingsNavigation(items, index, 'API KEY')).toEqual([{ ...items[1], sections: [] }]);
    expect(filterSettingsNavigation(items, index, '面板简介')).toEqual([{ ...items[0], sections: [] }]);
    expect(filterSettingsNavigation(items, index, 'missing')).toEqual([]);
  });

  it('notices changed body copy even when headings and elements stay the same', () => {
    const preview = section('preview', '预览', 0, '原说明');
    const previous = { editor: { searchText: '原说明', sections: [preview] } };
    expect(sameSettingsNavigation(previous, { editor: { ...previous.editor } })).toBe(true);
    expect(sameSettingsNavigation(previous, { editor: { ...previous.editor, searchText: '新说明' } })).toBe(false);
    for (const changed of [
      { ...preview, searchText: '新说明' },
      { ...preview, label: 'Preview' },
      { ...preview, element: elementAt(0) },
    ]) {
      expect(sameSettingsNavigation(previous, { editor: { ...previous.editor, sections: [changed] } })).toBe(false);
    }
    expect(sameSettingsNavigation(previous, { editor: { ...previous.editor, sections: [] } })).toBe(false);
    expect(sameSettingsNavigation(previous, {})).toBe(false);
  });

  it('measures nested targets relative to the scroll surface and tracks the last heading passed', () => {
    const main = Object.assign(elementAt(42), { scrollTop: 400 });
    expect(settingsTargetScrollTop(main, elementAt(258))).toBe(600);
    expect(settingsTargetScrollTop(main, elementAt(-500))).toBe(0);
    const sections = [section('preview', 'Preview', -200), section('type', 'Typesetting', 60), section('flow', 'Flow', 640)];
    expect(settingsItemAtTop(sections, 142)?.id).toBe('type');
    expect(settingsItemAtTop(sections, -300)).toBeUndefined();
    expect(settingsItemAtTop([], 142)).toBeUndefined();
  });

  it('jumps directly while preserving scroll-spy for manual scrolling', () => {
    const settings = read('src/renderer/features/settings/desktop/DesktopSettingsModal.tsx');
    const rail = read('src/renderer/features/settings/desktop/DesktopSettingsRail.tsx');
    const css = read('src/styles/settings.css');
    const docs = read('docs/design-system.md');

    expect(settings).toContain('main.addEventListener(\'scroll\', onScroll');
    expect(settings).toContain('className="set-main set-main--instant-section-nav"');
    expect(settings.match(/behavior: 'auto'/g)).toHaveLength(3);
    expect(settings).not.toContain("behavior: 'smooth'");
    expect(settings).toContain('data-settings-section');
    expect(rail).toContain('aria-controls={section.id}');
    expect(rail).toContain('<ul className="set-rail__sections">');
    expect(rail).not.toMatch(/<ul[^>]*\bhidden=/);
    expect(rail).not.toContain('aria-expanded');
    expect(css).not.toContain('.set-rail__item--active::before');
    expect(css).toMatch(
      /\.set-main--instant-section-nav\s*\{[\s\S]*?scroll-behavior:\s*auto;/,
    );
    expect(docs).toContain(
      '桌面完整 Settings 左侧 Section 点击后直接定位到目标内容，不播放纵向滚动动画',
    );
  });
});
