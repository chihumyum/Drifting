import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('comment anchor highlight acceptance', () => {
  it('mounts one painter per prose surface, including the whole-book reader', () => {
    const layer = source('src/renderer/components/editor/EditorReviewLayer.tsx');
    expect(layer).toMatch(/<CommentAnchorHighlights[\s\S]*?targetKind=\{entityType\}[\s\S]*?targetId=\{id\}/);
    for (const path of [
      'src/renderer/views/NodeEditorView.tsx',
      'src/renderer/views/ElementEditorView.tsx',
      'src/renderer/views/StorylineEditorView.tsx',
      'src/renderer/views/CategoryEditorView.tsx',
    ]) {
      expect(source(path)).toContain('<EditorReviewLayer');
    }
    const book = source('src/renderer/views/AllChaptersEditorView.tsx');
    expect(book).toMatch(/<CommentAnchorHighlights[\s\S]*?targetKind="node"[\s\S]*?targetId=\{null\}/);
    expect(book).toContain('ref={attachScroll}');
  });

  it('paints without DOM mutation and releases hidden surfaces', () => {
    const painter = source('src/renderer/lib/comment-highlight.ts');
    const mount = source('src/renderer/components/editor/CommentAnchorHighlights.tsx');
    expect(painter).toContain('CSS.highlights');
    expect(painter).not.toMatch(/classList|setAttribute|Decoration\./);
    expect(painter).toContain('this.observer?.disconnect()');
    expect(mount).toContain('const presented = isVisible || isPreparing;');
    expect(mount).not.toContain('visibleCommentIds');
  });

  it('links Review, sticky-note and TODO cards to their anchors on hover', () => {
    const card = source('src/renderer/features/comments/ReviewItemCard.tsx');
    expect(card).toContain('setActiveCommentHighlight(comment.id)');
    expect(card).toContain('clearActiveCommentHighlight(comment.id)');
  });

  it('styles resting washes and stronger hover overlays as background only', () => {
    const css = source('src/styles/comments-review.css');
    for (const name of ['comment-hl-manual', 'comment-hl-todo', 'comment-hl-manual-active',
      'comment-hl-copilot-active', 'comment-hl-todo-active']) {
      const start = css.indexOf(`::highlight(${name}) {`);
      expect(start).toBeGreaterThanOrEqual(0);
      const rule = css.slice(start, css.indexOf('}', start));
      expect(rule).toContain('background-color:');
      expect(rule).not.toMatch(/border|box-shadow/);
    }
    expect(css).not.toContain('::highlight(comment-hl-copilot) {');
  });

  it('documents the anchor contract next to the Review rail contract', () => {
    const doc = source('docs/qa/review-sticky-note-rail-2026-08-30.md');
    expect(doc).toContain('## Prose anchor highlights');
    expect(doc).toContain('comment-anchor-highlight.acceptance.test.ts');
  });
});
