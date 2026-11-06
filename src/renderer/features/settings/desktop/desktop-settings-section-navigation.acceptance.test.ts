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
import { designSystemDocs } from '../../../components/design-system-docs.test-support';

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
    const docs = designSystemDocs();

    expect(settings).toContain('main.addEventListener(\'scroll\', onScroll');
    expect(settings).toContain('className="set-main set-main--instant-section-nav"');
    expect(settings.match(/behavior: 'auto'/g)).toHaveLength(3);
    expect(settings).not.toContain("behavior: 'smooth'");
    expect(settings).toContain('data-settings-section');
    expect(rail).toContain('aria-controls={section.id}');
    expect(css).not.toContain('.set-rail__item--active::before');
    expect(css).toMatch(
      /\.set-main--instant-section-nav\s*\{[\s\S]*?scroll-behavior:\s*auto;/,
    );
    expect(docs).toContain(
      '桌面完整 Settings 左侧 Section 点击后直接定位到目标内容，不播放纵向滚动动画',
    );
  });

  it('lists every panel’s sections open, and folds one only from its own chevron', () => {
    const settings = read('src/renderer/features/settings/desktop/DesktopSettingsModal.tsx');
    const rail = read('src/renderer/features/settings/desktop/DesktopSettingsRail.tsx');
    const css = read('src/styles/settings.css');
    // The sand-and-glass rules restyle the structure laid out first, so the
    // last rule for a selector is the one that wins.
    const deskRule = (selector: string) => {
      const start = css.lastIndexOf(`\n${selector} {`);
      expect(start, selector).toBeGreaterThanOrEqual(0);
      return css.slice(start, css.indexOf('}', start));
    };

    // Open by default; a fold is component state, gone when Settings closes.
    expect(rail).toContain('useState<ReadonlySet<string>>(() => new Set())');
    expect(rail).not.toMatch(/localStorage|persist/);
    expect(settings).toContain('if (!isOpen) return null;');
    // The chevron is its own button; the row itself still jumps to the panel.
    expect(rail).toContain('className="set-rail__fold"');
    expect(rail).toContain('aria-expanded={open}');
    expect(rail).toContain('aria-controls={sectionsId}');
    expect(rail).toContain('onClick={() => onSelect(item.id)}');
    expect(rail).toContain('name="chevron-right"');
    // A search lists its matches open and offers no fold.
    expect(settings).toContain("searching={query.trim() !== ''}");
    expect(rail).toContain('const foldable = item.sections.length > 0 && !searching;');
    // A folded list leaves the tab order; its current section shows on the row.
    expect(rail).toContain('inert={!open}');
    expect(rail).toContain('const current = selected && (!activeSection || !open);');
    expect(deskRule('.set-rail__sections-fold')).toContain('grid-template-rows: 0fr;');
    expect(deskRule('.set-rail__sections-fold.is-open')).toContain('grid-template-rows: 1fr;');
    expect(deskRule('.set-rail__fold-chevron--open')).toContain('transform: rotate(90deg);');
    // Pointing at the chevron rings the whole row.
    expect(css).toContain('\n.set-rail__row:hover > .set-rail__item::before,');
  });

  it('sets the rail’s three levels at one size, sections starting where their panel’s words do', () => {
    const css = read('src/styles/settings.css');
    const rule = (selector: string) => {
      const start = css.indexOf(`${selector} {`);
      expect(start, selector).toBeGreaterThanOrEqual(0);
      return css.slice(start, css.indexOf('}', start));
    };
    // The sand-and-glass rules restyle the structure laid out first, so the
    // last rule for a selector is the one that wins.
    const deskRule = (selector: string) => {
      const start = css.lastIndexOf(`\n${selector} {`);
      expect(start, selector).toBeGreaterThanOrEqual(0);
      return css.slice(start, css.indexOf('}', start));
    };
    for (const selector of ['.set-rail__group-title', '.set-rail__item', '.set-rail__section']) {
      expect(deskRule(selector)).toContain('font-size: var(--ui-font-body, 14px);');
    }
    // The panel row: 8px padding, a 16px glyph and a 9px gap before its name.
    const item = deskRule('.set-rail__item');
    expect(item).toContain('padding: 0 8px;');
    expect(item).toContain('gap: 9px;');
    expect(rule('.set-rail__glyph')).toContain('width: 16px;');
    expect(deskRule('.set-rail__sections')).toContain('padding: 0 0 4px 25px;');
    // The current place is its ring and its ink, never a heavier word.
    const current = deskRule('.set-rail__item--active,\n.set-rail__section--active');
    expect(current).toContain('font-weight: 400;');
    expect(css.slice(css.indexOf('Sand and plain glass'))).not.toMatch(/set-rail__(?:item|section)--active[^{]*\{[^}]*font-weight: [5-9]00/);
    expect(rule('.set-rail__section')).toContain('padding: 0 8px;');
    expect(designSystemDocs()).toContain('二级的字从一级的字那一列开始');
  });
});
