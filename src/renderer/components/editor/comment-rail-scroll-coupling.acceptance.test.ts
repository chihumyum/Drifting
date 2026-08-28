import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('comment rail visual and native-scroll coupling acceptance', () => {
  it('mounts the node comment rail in the manuscript native scroll tree', () => {
    const nodeEditor = source('src/renderer/views/NodeEditorView.tsx');

    expect(nodeEditor).toMatch(
      /<div className="editor__spread">[\s\S]*?<\/article>\s*\{\/\* Keep the rail in the editor's native scroll tree\.[\s\S]*?\*\/\}\s*\{marginNotes && \(\s*<CommentRail[\s\S]*?<\/div>\s*<\/div>\s*<EditorReviewLayer/,
    );
    expect(nodeEditor).not.toContain('Comment rail lives OUTSIDE .editor-scroll');
  });

  it('uses native compositor scrolling and keeps JS positioning as a portal fallback', () => {
    const commentRail = source('src/renderer/components/editor/CommentRail.tsx');

    expect(commentRail).toContain(
      'const nativeScrollCoupled = margin ? scrollEl.contains(margin) : false;',
    );
    expect(commentRail).toMatch(
      /if \(!nativeScrollCoupled\) \{\s*scrollEl\.addEventListener\('scroll', onScroll, \{ passive: true \}\);/,
    );
    expect(commentRail).toMatch(
      /if \(!nativeScrollCoupled\) \{\s*scrollEl\.removeEventListener\('scroll', onScroll\);/,
    );
  });

  it('reveals mobile cards without painting a paper-side color strip', () => {
    const css = source('src/styles/mobile-workspace.css');
    const openRuleStart = css.indexOf(
      ".m-workspace[data-rail-comments='true'] .editor__margin {",
    );
    const openRuleEnd = css.indexOf('\n}', openRuleStart);
    const openRule = css.slice(openRuleStart, openRuleEnd);

    expect(openRuleStart).toBeGreaterThanOrEqual(0);
    expect(openRule).toContain('background: transparent;');
    expect(openRule).not.toContain('linear-gradient');
  });

  it('records the cross-platform behavior and validation boundary durably', () => {
    const evidence = source('docs/qa/comment-rail-native-scroll-coupling-2026-08-28.md');

    expect(evidence).toContain('must not add a color strip, gradient, wash, or opaque veil');
    expect(evidence).toMatch(/share one vertical scroll\s+coordinate/);
    expect(evidence).toContain('No Simulator, physical-device touch');
  });
});
