import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('semantic outline rail acceptance wiring', () => {
  it('mounts the permanent rail in all five prose editors', () => {
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

  it('retires the outline visibility preference and top-bar toggle', () => {
    const topBar = source('src/renderer/components/editor/EditorTopBar.tsx');
    const uiStore = source('src/renderer/store/ui-store.ts');
    const app = source('src/renderer/App.tsx');

    expect(topBar).not.toContain('ListTree');
    expect(topBar).not.toContain('outlineCollapsed');
    expect(uiStore).not.toContain('outlineCollapsed');
    expect(app).not.toContain("classList.add('is-scrolling')");
  });

  it('uses one accessible scrollbar coordinate for TOC and review markers', () => {
    const rail = source('src/renderer/components/editor/EditorOutlineRail.tsx');
    const css = source('src/styles/index.css');
    const semanticRailCss = css.slice(
      css.indexOf('Semantic outline scrollbar'),
      css.indexOf('Scene + Beat headers'),
    );

    expect(rail).toContain('role="scrollbar"');
    expect(rail).toContain('data-density={plan.mode}');
    expect(rail).toContain("data-placement={edgeMode ? 'edge' : 'resident'}");
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
    expect(
      semanticRailCss.match(/\.editor__toc-rail--edge\s*\{[^}]*\}/)?.[0],
    ).not.toContain('opacity: 0');
    expect(semanticRailCss).toContain('.editor__toc-rail.is-active .editor__toc-labels');
    expect(semanticRailCss).toContain('.editor__toc-viewport-range');
    expect(semanticRailCss).not.toMatch(
      /\.editor__toc-tag\.is-(?:visible|primary)\s*\{[^}]*background/,
    );
    expect(css).not.toContain('toc-dock');
    expect(css).toContain('scrollbar-width: none;');
    expect(css).toContain('.editor-scroll::-webkit-scrollbar');
    expect(css).toMatch(/\.editor__scrollmap\s*\{[\s\S]*?left:\s*calc\(var\(--editor-toc-rail-left\)/);
    expect(css).not.toContain('.editor__toc-overlay');
  });

  it('keeps durable documentation aligned with the three density modes', () => {
    const doc = source('docs/editor/semantic-outline-rail.md');
    expect(doc).toContain('1. `all`');
    expect(doc).toContain('2. `active-branch`');
    expect(doc).toContain('3. `windowed`');
    expect(doc).toContain('1. `resident`');
    expect(doc).toContain('2. `edge`');
    expect(doc).toContain('plain-text');
    expect(doc).toContain('two scrollbar layers');
    expect(doc).toContain('physical-device');
  });
});
