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

    expect(source('src/renderer/views/AllChaptersEditorView.tsx')).not.toContain("kind: 'entity'");

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

  it('toggles persisted TOC visibility directly beside Entity Link', () => {
    const topBar = source('src/renderer/components/editor/EditorTopBar.tsx');
    const rail = source('src/renderer/components/editor/EditorOutlineRail.tsx');
    const settings = source('src/renderer/store/settings-store.ts');
    const uiStore = source('src/renderer/store/ui-store.ts');
    const workspace = source('src/renderer/shells/desktop/DesktopWorkspace.tsx');
    const outlineToggle = topBar.slice(
      topBar.indexOf('function OutlineRailToggle'),
      topBar.indexOf('function injectSeparators'),
    );

    expect(outlineToggle).toContain('editor-bar__icon--outline');
    expect(outlineToggle).toContain('aria-pressed={visible}');
    expect(outlineToggle).toContain("setMode(visible ? 'hidden' : 'visible')");
    expect(outlineToggle).not.toContain('role="menuitemradio"');
    expect(outlineToggle).not.toContain('<AnchoredPopover');
    expect(topBar).not.toContain('editor-bar__outline-menu');
    expect(topBar.indexOf('<OutlineRailToggle')).toBeLessThan(
      topBar.indexOf('editor-bar__icon--reflink'),
    );
    expect(rail).toContain("presentation?.outlineVisible ?? outlineRailMode !== 'hidden'");
    expect(rail).toContain('if (!visible) return null;');
    expect(rail).not.toContain('data-display-mode');
    expect(settings).toContain("export type OutlineRailMode = 'visible' | 'hidden';");
    expect(settings).toContain("OUTLINE_RAIL_MODE_DEFAULT: OutlineRailMode = 'visible'");
    expect(settings).toContain("value === 'always' || value === 'auto'");
    expect(settings).toContain(
      'setOutlineRailMode: (mode) => set({ outlineRailMode: normalizeOutlineRailMode(mode) })',
    );
    expect(topBar).not.toContain('outlineCollapsed');
    expect(uiStore).not.toContain('outlineCollapsed');
    expect(workspace).not.toContain("classList.add('is-scrolling')");
  });

  it('keeps the TOC on the left and overlays clickable review markers on the right scrollbar', () => {
    const rail = source('src/renderer/components/editor/EditorOutlineRail.tsx');
    const scrollMarkers = source('src/renderer/components/editor/EditorScrollMarkers.tsx');
    const model = source('src/renderer/components/editor/outline-rail-model.ts');
    const css = source('src/styles/index.css');
    const commentsReviewCss = source('src/styles/comments-review.css');
    const workspace = source('src/renderer/shells/desktop/DesktopWorkspace.tsx');
    const desktopShellCss = source('src/styles/desktop-shell.css');
    const semanticRailCss = commentsReviewCss.slice(
      commentsReviewCss.indexOf('Semantic TOC rail'),
      commentsReviewCss.indexOf('Scene + Beat headers'),
    );
    const editorScrollbarCss = css.slice(
      css.indexOf('.editor-scroll {'),
      css.indexOf('/* `.editor-scroll--comments`'),
    );

    expect(rail).toContain('data-density={plan.mode}');
    expect(rail).toContain('data-placement="edge"');
    expect(rail).toContain('visibleOutlineIds(');
    expect(rail).toContain("visible ? 'is-visible' : ''");
    expect(rail).toContain('omissionRevealEntries(');
    expect(rail).not.toContain('role="scrollbar"');
    expect(rail).not.toContain('editor__toc-track');
    expect(rail).not.toContain('editor__toc-thumb');
    expect(rail).not.toContain('editor__toc-viewport-range');
    expect(rail).not.toContain('handleTrackPointerDown');
    expect(rail).not.toContain('handleTrackKeyDown');
    expect(model).not.toContain('outlineVisibleLabelRange');
    expect(semanticRailCss).not.toContain('scale(');
    expect(semanticRailCss).toContain('.editor__toc-rail--edge .editor__toc-tag');
    expect(semanticRailCss).toMatch(
      /\.editor__toc-rail\s*\{[\s\S]*?left:\s*0;[\s\S]*?width:\s*min\(190px/,
    );
    expect(semanticRailCss).toMatch(
      /\.editor__toc-rail--edge \.editor__toc-tag,[\s\S]*?left:\s*12px;/,
    );
    expect(semanticRailCss).toContain('.editor__toc-rail.is-active .editor__toc-labels');
    expect(semanticRailCss).not.toContain('.editor__toc-track');
    expect(semanticRailCss).not.toContain('.editor__toc-viewport-range');
    expect(semanticRailCss).not.toContain('.editor__toc-thumb');
    expect(semanticRailCss).not.toMatch(
      /\.editor__toc-tag\.is-(?:visible|primary)\s*\{[^}]*background/,
    );
    expect(commentsReviewCss).not.toContain('toc-dock');
    expect(editorScrollbarCss).toContain('overflow-y: scroll;');
    expect(editorScrollbarCss).toContain('overflow-x: hidden;');
    expect(editorScrollbarCss).toContain('overscroll-behavior: none;');
    expect(editorScrollbarCss).toContain('scrollbar-gutter: stable;');
    expect(editorScrollbarCss).toContain('scrollbar-width: thin;');
    expect(editorScrollbarCss).toContain('.editor-scroll::-webkit-scrollbar');
    expect(editorScrollbarCss).toMatch(
      /\.editor-scroll::-webkit-scrollbar\s*\{[\s\S]*?width:\s*8px;/,
    );
    expect(editorScrollbarCss).toMatch(
      /\.editor-scroll::-webkit-scrollbar-thumb\s*\{[\s\S]*?background:\s*hsl\(var\(--rule\)\);/,
    );
    expect(editorScrollbarCss).not.toContain('scrollbar-width: none;');
    expect(editorScrollbarCss).not.toContain('display: none;');
    expect(rail).toContain('root.scrollBy({ top: event.deltaY });');
    expect(rail).not.toContain('left: event.deltaX');
    expect(workspace).toContain('className="workspace-stage desktop-workspace-stage"');
    expect(desktopShellCss).toMatch(/\.desktop-workspace-stage\s*\{[\s\S]*?overflow:\s*hidden;/);
    expect(desktopShellCss).not.toMatch(/\.desktop-workspace-stage\s*\{[^}]*overflow-y:\s*auto;/);
    expect(commentsReviewCss).toMatch(
      /\.editor__scrollmap\s*\{[\s\S]*?right:\s*0;[\s\S]*?width:\s*8px;[\s\S]*?pointer-events:\s*none;/,
    );
    expect(commentsReviewCss).not.toMatch(/\.editor__scrollmap\s*\{[^}]*left:\s*0;/);
    expect(commentsReviewCss).toMatch(
      /\.editor__scrollmap-tick\s*\{[\s\S]*?pointer-events:\s*auto;/,
    );
    expect(scrollMarkers).toContain('onClick={() => jump(t.blockIds)}');
    expect(scrollMarkers).toContain("scrollIntoView({ behavior: 'smooth', block: 'center' })");
    expect(scrollMarkers).toContain('blocks.forEach(flashBlock)');
    expect(commentsReviewCss).not.toContain('.editor__toc-overlay');
  });

  it('keeps durable documentation aligned with the separated TOC and scrollbar', () => {
    const doc = source('docs/editor/semantic-outline-rail.md');
    expect(doc).toContain('1. `all`');
    expect(doc).toContain('2. `active-branch`');
    expect(doc).toContain('3. `windowed`');
    expect(doc).toContain("editor area's left edge");
    expect(doc).toContain('right edge');
    expect(doc).toMatch(/directly over that native\s+scrollbar/);
    expect(doc).toMatch(/Only the marker ticks\s+capture clicks/);
    expect(doc).toContain('existing plain-text TOC tags');
    expect(doc).toContain('retired dual-layer implementation is absent');
    expect(doc).toContain('1. `visible`');
    expect(doc).toContain('2. `hidden`');
    expect(doc).toMatch(/toggles the preference\s+immediately/);
    expect(doc).toContain('does not open a dropdown');
    expect(doc).toMatch(/immediately beside the\s+Entity Link/);
    expect(doc).toContain('do not synthesize the entity name');
    expect(doc).toMatch(/TOC label lane (?:stays|is)\s+blank/);
    expect(doc).toContain('physical-device');
  });
});
