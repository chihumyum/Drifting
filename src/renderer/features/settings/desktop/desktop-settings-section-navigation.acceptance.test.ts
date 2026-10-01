import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  filterSettingsNavigation,
  readSettingsSections,
  sameSettingsSections,
  settingsItemAtTop,
  settingsTargetScrollTop,
  type SettingsNavigationSection,
} from './settings-section-navigation';

const root = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('desktop settings section navigation', () => {
  const elementAt = (top: number) => ({ getBoundingClientRect: () => ({ top }) }) as HTMLElement;
  const section = (id: string, label: string, top = 0): SettingsNavigationSection => ({ id, label, element: elementAt(top) });

  it('finds translated subsections while retaining their parent and filters unrelated children', () => {
    const items = [{ id: 'editor', label: '编辑器' }, { id: 'agent', label: 'Agent' }, { id: 'trash', label: '回收站' }];
    const sections = { editor: [section('preview', '预览'), section('type', '排版')], agent: [section('memory', 'Memory')] };
    expect(filterSettingsNavigation(items, sections, ' 排版 ')).toEqual([{ ...items[0], sections: [sections.editor[1]] }]);
    expect(filterSettingsNavigation(items, sections, 'EDITOR')[0].sections).toEqual(sections.editor);
    expect(filterSettingsNavigation(items, sections, 'mEMory')[0].id).toBe('agent');
    expect(filterSettingsNavigation(items, sections, '')).toHaveLength(3);
    expect(filterSettingsNavigation(items, sections, 'missing')).toEqual([]);
  });

  it('reads only mounted visible headings and notices translated or replaced content', () => {
    const heading = (id: string, label: string, visible = true, panel: string | null = 'editor') => ({
      id, dataset: { settingsSection: label }, closest: () => panel ? { id: panel } : null,
      getClientRects: () => visible ? [{}] : [],
    });
    const headings = [heading('preview', '预览'), heading('hidden', 'Hidden', false), heading('empty', ''), heading('outside', 'Outside', true, null)];
    const main = { querySelectorAll: () => headings } as unknown as HTMLElement;
    const sections = readSettingsSections(main);
    expect(sections.editor.map(s => s.id)).toEqual(['preview']);
    expect(sameSettingsSections(sections, readSettingsSections(main))).toBe(true);
    headings[0].dataset.settingsSection = 'Preview';
    expect(sameSettingsSections(sections, readSettingsSections(main))).toBe(false);
    headings[0] = heading('preview', '预览');
    expect(sameSettingsSections(sections, readSettingsSections(main))).toBe(false);
    expect(sameSettingsSections(sections, {})).toBe(false);
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
