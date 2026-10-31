import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { designSystemDocs } from './design-system-docs.test-support';

const root = resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFileSync(resolve(root, relative), 'utf8');

function block(text: string, start: string): string {
  const startIndex = text.indexOf(start);
  expect(startIndex, `missing rule: ${start}`).toBeGreaterThanOrEqual(0);
  return text.slice(startIndex, text.indexOf('}', startIndex));
}

describe('the serif structure face beyond the sidebars', () => {
  it('sets Story Graph lane names like the Bottom Timeline rail', () => {
    const rule = block(read('src/styles/graph-view.css'), '.graph-rail-cell--glass .graph-rail__name {');
    expect(rule).toContain('font-family: var(--font-structure);');
    expect(rule).toContain('font-weight: 400;');
    expect(read('src/styles/interface-fonts.css')).toContain('.btl-rail__name');
  });

  it('sets act names on the act rail as acts are in the outline, keeping the count index type', () => {
    const css = read('src/styles/act-rail.css');
    const rule = block(css, '.actrail--glass .actrail__name,\n.actrail--glass .actrail__edit {');
    expect(rule).toContain('font-family: var(--font-structure);');
    expect(rule).toContain('font-size: 11px;');
    expect(block(css, '.actrail__count {')).toContain('font-family: var(--font-mono);');
    // A Chinese act name drops onto the Latin line to centre in its chip.
    expect(read('src/renderer/components/BottomTimeline/ActRail.tsx')).toContain(
      "data-script={CJK_TEXT.test(seg.act.name) ? 'cjk' : undefined}",
    );
    expect(block(css, ".actrail--glass .actrail__name[data-script='cjk'] {")).toContain('top: 0.15em;');
  });

  it('sets the book’s storylines and categories on Project Home, not its recent chapters and elements', () => {
    const view = read('src/renderer/views/ProjectDashboard.tsx');
    expect(view).toContain('className="sand-cell dash-cell dash-cell--category"');
    expect(view.match(/className="sand-cell dash-cell"/g)).toHaveLength(2);
    const rule = block(read('src/styles/dashboard.css'), '.dash-line__name,\n.dash-cell--category .dash-cell__name {');
    expect(rule).toContain('font-family: var(--font-structure);');
  });

  it('sets the Super View destinations at one weight, leaving the views’ own modes in the UI face', () => {
    const css = read('src/styles/super-view-header.css');
    const desktop = "html:not([data-shell-mode='mobile'])";
    // 书序／叙事时 and the other sliders in a view's header are controls.
    expect(block(css, `${desktop} .super-view-head .glass-slider__option {`)).toContain('var(--font-sans)');
    const views = block(css, `${desktop} .super-view-head__views .glass-slider__option,`);
    expect(views).toContain(`${desktop} .super-view-head__views .glass-slider__option[aria-checked='true'] {`);
    expect(views).toContain('font-family: var(--font-structure);');
    expect(views).toContain('font-weight: 400;');
    expect(block(css, `${desktop} .super-view-head__views [data-script='cjk'] {`)).toContain('top: 0.15em;');
    // Sized like the Panel Tabs' row: the slab 2px short of the header's top
    // and bottom (as .panel-tab-tray__block), 12px between the names.
    const track = block(css, `${desktop} .super-view-head__views .glass-slider {`);
    expect(track).toContain('gap: 12px;');
    expect(track).toContain('height: calc(var(--window-titlebar-height) - 4px);');
    const tray = read('src/styles/ui-controls.css');
    expect(block(tray, '.panel-tab-tray > .panel-tab-tray__block.glass {')).toMatch(/top: 2px;[\s\S]*bottom: 2px;/);
    expect(block(tray, "html[data-shell-mode='desktop'] :is(.leftbar-tab-tray, .rightbar-tab-tray) {")).toContain('gap: 12px;');
    expect(read('src/renderer/shells/desktop/components/DesktopSuperViewHeader.tsx')).toContain(
      "data-script={CJK_TEXT.test(label) ? 'cjk' : undefined}",
    );
    // One definition of the ideograph range, shared with the Panel Tabs.
    expect(read('src/renderer/components/ui/PanelTabs.tsx')).toContain(
      "import { CJK_TEXT } from '../../lib/interface-typography';",
    );
  });

  it('sets each settings section heading in the structure face, keeping the rail as it was', () => {
    const css = read('src/styles/settings.css');
    const title = block(css, ":where(html:not([data-shell-mode='mobile'])) .set-panel__title {");
    expect(title).toContain('font-family: var(--font-structure);');
    expect(title).toContain('font-weight: 400;');
    expect(block(css, ":where(html:not([data-shell-mode='mobile'])) .set-rail__item {")).not.toContain('--font-structure');
  });

  it('sets material folders, not materials, in the structure face', () => {
    const tree = read('src/renderer/features/library/MaterialFolderTree.tsx');
    expect(tree).toContain('<span className="material-tree__name">{folder.name}</span>');
    expect(tree.match(/className="material-tree__name"/g)).toHaveLength(1);
    const css = read('src/styles/material-workbench.css');
    expect(block(css, '.material-tree__name {')).toContain('font-family: var(--font-structure);');
    expect(block(css, '.material-tree__title {')).not.toContain('--font-structure');
  });

  it('names the shelf in the structure face, leaving each book in its own prose font', () => {
    const css = read('src/styles/project-picker.css');
    expect(block(css, '.pp-head__title {')).toContain('font: 400 22px/1.2 var(--font-structure);');
    expect(block(css, '.pp-bar__title {')).toContain('font: 400 16px/1 var(--font-structure);');
    expect(block(css, '.pp-card__title {')).toContain('var(--font-content)');
    expect(block(css, '.pp-cover__glyph {')).toContain('var(--font-content)');
    // The filters' counts stand apart from their words.
    expect(block(css, '.pp-bar__filters .pp-bar__n {')).toContain('margin-left: 4px;');
  });

  it('sets material kinds in the structure face in TODO & 素材库, their counts index type', () => {
    const view = read('src/renderer/shells/desktop/views/DesktopSuperMemoMaterialView.tsx');
    expect(view).toContain("<span {...look(mobileShell, 'smm-kind-group__name')}>");
    const css = read('src/styles/super-memo-material.css');
    expect(block(css, '.smm-kind-group__name {')).toContain('font-family: var(--font-structure);');
    expect(block(css, '.smm-kind-group__head {')).toContain('align-items: baseline;');
    expect(block(css, '.smm-index-count {')).toContain('font-family: var(--font-mono);');
  });

  it('falls back to the UI face on the paused mobile shell', () => {
    expect(read('src/styles/index.css')).toContain('--font-structure: var(--font-ui);');
  });

  it('documents where the structure face reaches', () => {
    const docs = designSystemDocs();
    expect(docs).toContain('Super View 的视图切换、设置每一节的页题');
    expect(docs).toContain('素材文件夹与「TODO 与素材库」里的种类组头、书架的「书架」与「全部作品」、时间线与故事图谱的故事线泳道名、幕名');
    expect(docs).toContain('三个视图是去处，和 Panel Tab 一样用结构字');
    expect(docs).toContain('文件夹名是结构字、素材条目是实体字');
    expect(docs).toContain('书架的「书架」与「全部作品」是地方的名字，也用结构字');
  });
});
