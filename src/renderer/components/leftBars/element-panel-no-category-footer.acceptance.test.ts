import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('ElementPanel without a category footer', () => {
  it('keeps categories and elements in one vertical scroll surface', () => {
    const panel = source('src/renderer/components/leftBars/ElementPanel.tsx');

    expect(panel.match(/className="left-panel-scroll"/g)).toHaveLength(1);
    expect(panel).toContain('<GroupHeaderCell');
    expect(panel).toContain('sticky');
    expect(panel).toContain("if (categoryId === UNCATEGORIZED_ID)");
    expect(panel).not.toContain('left-panel-cat-footer');
    expect(panel).not.toContain('scrollToCategory');
    expect(panel).not.toContain('startFooterResize');
    expect(panel).not.toContain('IntersectionObserver');
    expect(panel).not.toContain('data-category-section');
    expect(panel).not.toContain('data-category-id');
  });

  it('removes the footer persistence, styling, copy, and visibility helper', () => {
    const store = source('src/renderer/store/ui-store.ts');
    const controls = source('src/styles/ui-controls.css');
    const en = JSON.parse(source('src/renderer/locales/en.json'));
    const zh = JSON.parse(source('src/renderer/locales/zh-CN.json'));
    const designSystem = source('docs/design-system.md');

    expect(store).not.toContain('elementCategoryFooterHeight');
    expect(store).not.toContain('setElementCategoryFooterHeight');
    expect(controls).not.toContain('left-panel-cat-footer');
    expect(en.leftSidebar.groups.resizeFooter).toBeUndefined();
    expect(zh.leftSidebar.groups.resizeFooter).toBeUndefined();
    expect(
      existsSync(
        resolve(
          process.cwd(),
          'src/renderer/components/leftBars/element-panel-category-visibility.ts',
        ),
      ),
    ).toBe(false);
    expect(designSystem).toContain('元素 panel 不再设置 category footer');
  });
});
