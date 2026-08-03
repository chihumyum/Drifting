import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('semantic outline rail acceptance wiring', () => {
  it('mounts the shared rail in all five prose editors', () => {
    const views = [
      'src/renderer/views/AllChaptersEditorView.tsx',
      'src/renderer/views/NodeEditorView.tsx',
      'src/renderer/views/ElementEditorView.tsx',
      'src/renderer/views/CategoryEditorView.tsx',
      'src/renderer/views/StorylineEditorView.tsx',
    ];
    for (const view of views) {
      expect(source(view), view).toContain('<EditorOutlineRail');
      expect(source(view), view).not.toContain('EditorOutlinePanel');
    }
  });

  it('keeps single-entity names out of the manuscript TOC', () => {
    const singleEntityViews = [
      'src/renderer/views/NodeEditorView.tsx',
      'src/renderer/views/ElementEditorView.tsx',
      'src/renderer/views/CategoryEditorView.tsx',
      'src/renderer/views/StorylineEditorView.tsx',
    ];
    for (const view of singleEntityViews) {
      const viewSource = source(view);
      expect(viewSource, view).not.toContain("kind: 'entity'");
      expect(viewSource, view).not.toContain('outlineRootId');
    }

    expect(source('src/renderer/views/AllChaptersEditorView.tsx')).not.toContain(
      "kind: 'entity'",
    );

    const model = source('src/renderer/components/editor/outline-rail-model.ts');
    expect(model).not.toContain("'entity'");

    const scrollspy = source('src/renderer/components/editor/use-outline-scrollspy.ts');
    expect(scrollspy).toContain('scrollRoot.querySelector');
    expect(scrollspy).not.toContain('document.querySelector');
    expect(scrollspy).not.toContain('document.getElementById');
  });

  it('leaves an empty prose outline blank instead of showing heading instructions', () => {
    const rail = source('src/renderer/components/editor/EditorOutlineRail.tsx');
    const nodeEditor = source('src/renderer/views/NodeEditorView.tsx');
    const elementEditor = source('src/renderer/views/ElementEditorView.tsx');
    const en = source('src/renderer/locales/en.json');
    const zh = source('src/renderer/locales/zh-CN.json');

    expect(rail).toContain('flat.length === 0 && emptyHint &&');
    expect(rail).not.toContain("t('editorOutline.emptyHint')");
    expect(nodeEditor).not.toContain("emptyHint={t('nodeEditor.outline.empty')}");
    expect(elementEditor).not.toContain("emptyHint={t('nodeEditor.outline.empty')}");
    expect(en).not.toContain('Use H1 / H2 / H3 headings to build an outline');
    expect(zh).not.toContain('用 H1 / H2 / H3 标题构建大纲');
  });

  it('offers persisted always, auto-hide, and hidden modes beside Entity Link', () => {
    const topBar = source('src/renderer/components/editor/EditorTopBar.tsx');
    const rail = source('src/renderer/components/editor/EditorOutlineRail.tsx');
    const settings = source('src/renderer/store/settings-store.ts');
    const preferences = source('src/renderer/services/preferences-sync.service.ts');
    const uiStore = source('src/renderer/store/ui-store.ts');
    const app = source('src/renderer/App.tsx');

    expect(topBar).toContain("['always', 'auto', 'hidden']");
    expect(topBar).toContain('role="menuitemradio"');
    expect(topBar).toContain('editor-bar__icon--outline');
    expect(topBar.indexOf('<OutlineRailModeMenu')).toBeLessThan(
      topBar.indexOf('editor-bar__icon--reflink'),
    );
    expect(rail).toContain("if (outlineRailMode === 'hidden') return null;");
    expect(rail).toContain("displayMode === 'always'");
    expect(rail).toContain('data-display-mode={displayMode}');
    expect(settings).toContain("export type OutlineRailMode = 'always' | 'auto' | 'hidden';");
    expect(settings).toContain("OUTLINE_RAIL_MODE_DEFAULT: OutlineRailMode = 'auto'");
    expect(settings).toContain('version: 26');
    expect(preferences).toContain("'outlineRailMode'");
    expect(topBar).not.toContain('outlineCollapsed');
    expect(uiStore).not.toContain('outlineCollapsed');
    expect(app).not.toContain("classList.add('is-scrolling')");
  });

  it('uses one accessible scrollbar coordinate for TOC and review markers', () => {
    const rail = source('src/renderer/components/editor/EditorOutlineRail.tsx');
    const css = source('src/styles/index.css');
    const app = source('src/renderer/App.tsx');
    const semanticRailCss = css.slice(
      css.indexOf('Semantic outline scrollbar'),
      css.indexOf('Scene + Beat headers'),
    );

    expect(rail).toContain('role="scrollbar"');
    expect(rail).toContain('data-density={plan.mode}');
    expect(rail).toContain('data-placement="edge"');
    expect(rail).not.toContain('edgeMode');
    expect(rail).not.toContain('planOutlineRailPlacement');
    expect(rail).toContain('SCROLL_ACTIVE_IDLE_MS');
    expect(rail).toContain('(geometry.clientHeight / geometry.scrollHeight) * trackHeight');
    expect(rail).toContain('outlineVisibleLabelRange(');
    expect(rail).toContain('className="editor__toc-viewport-range"');
    expect(rail).toContain('setSemanticTargetId(id)');
    expect(rail).toContain('visibleOutlineIds(');
    expect(rail).toContain('omissionRevealEntries(');
    expect(rail).not.toContain('pointerY');
    expect(semanticRailCss).not.toContain('scale(');
    expect(semanticRailCss).toContain('.editor__toc-rail--edge .editor__toc-tag');
    expect(semanticRailCss).toMatch(
      /\.editor__toc-rail--edge \.editor__toc-labels,[\s\S]*?\.editor__toc-viewport-range\s*\{\s*opacity:\s*0;/,
    );
    expect(semanticRailCss).toMatch(
      /\.editor__toc-rail\s*\{[\s\S]*?left:\s*0;[\s\S]*?width:\s*min\(190px/,
    );
    expect(semanticRailCss).toContain('.editor__toc-rail.is-active .editor__toc-labels');
    expect(semanticRailCss).toContain('.editor__toc-viewport-range');
    expect(semanticRailCss).toMatch(
      /\.editor__toc-viewport-range\s*\{[\s\S]*?border-radius:\s*0;/,
    );
    expect(semanticRailCss).toMatch(/\.editor__toc-thumb\s*\{[\s\S]*?border-radius:\s*0;/);
    expect(semanticRailCss).toMatch(/\.editor__toc-thumb\s*\{[\s\S]*?box-shadow:\s*none;/);
    expect(semanticRailCss).not.toContain('0 0 0 1px hsl(var(--surface)');
    expect(semanticRailCss).not.toMatch(
      /\.editor__toc-tag\.is-(?:visible|primary)\s*\{[^}]*background/,
    );
    expect(css).not.toContain('toc-dock');
    expect(css).toContain('scrollbar-width: none;');
    expect(css).toContain('.editor-scroll::-webkit-scrollbar');
    expect(css).toMatch(/\.editor-scroll\s*\{[\s\S]*?overflow-x:\s*hidden;/);
    expect(css).toMatch(/\.editor-scroll\s*\{[\s\S]*?overscroll-behavior:\s*none;/);
    expect(rail).toContain('root.scrollBy({ top: event.deltaY });');
    expect(rail).not.toContain('left: event.deltaX');
    const workspaceStage = app.slice(app.indexOf('className="workspace-stage"'));
    expect(workspaceStage).toContain("overflowY: 'hidden'");
    expect(workspaceStage).not.toContain("overflowY: 'auto'");
    expect(css).toMatch(/\.editor__scrollmap\s*\{[\s\S]*?left:\s*0;/);
    expect(css).not.toContain('.editor__toc-overlay');
  });

  it('keeps durable documentation aligned with the three density modes', () => {
    const doc = source('docs/editor/semantic-outline-rail.md');
    expect(doc).toContain('1. `all`');
    expect(doc).toContain('2. `active-branch`');
    expect(doc).toContain('3. `windowed`');
    expect(doc).toContain('editor area’s left edge');
    expect(doc).toContain('right of the scrollbar');
    expect(doc).toContain('plain-text');
    expect(doc).toContain('two scrollbar layers');
    expect(doc).toContain('1. `always`');
    expect(doc).toContain('2. `auto`');
    expect(doc).toContain('3. `hidden`');
    expect(doc).toContain('immediately beside the Entity Link');
    expect(doc).toContain('do not synthesize the entity name');
    expect(doc).toMatch(/leaves its TOC label\s+lane blank/);
    expect(doc).toContain('physical-device');
  });
});
