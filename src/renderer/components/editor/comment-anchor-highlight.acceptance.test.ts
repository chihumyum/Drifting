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

  it('paints without touching the prose and releases hidden surfaces', () => {
    // Every shell draws anchors in sand on a layer of its own after the page
    // (lib/comment-sand.ts); the flat ::highlight() painter is gone.
    const painter = source('src/renderer/lib/comment-sand.ts');
    const mount = source('src/renderer/components/editor/CommentAnchorHighlights.tsx');
    expect(source('src/renderer/lib/comment-highlight.ts')).not.toContain('CSS.highlights');
    expect(painter).not.toMatch(/classList|Decoration\./);
    expect(painter).toContain("layer.setAttribute('aria-hidden', 'true');");
    expect(painter).toContain('this.mutation?.disconnect();');
    expect(painter).toContain('for (const host of this.hosts.values()) host.layer.remove();');
    expect(mount).toContain('new CommentSandPainter(scrollEl)');
    expect(mount).toContain('const presented = isVisible || isPreparing;');
    expect(mount).not.toContain('visibleCommentIds');
  });

  it('links Review, sticky-note and TODO cards to their anchors on hover', () => {
    const card = source('src/renderer/features/comments/ReviewItemCard.tsx');
    expect(card).toContain('setActiveCommentHighlight(comment.id)');
    expect(card).toContain('clearActiveCommentHighlight(comment.id)');
  });

  it('keeps no flat ::highlight() washes for comment anchors', () => {
    const css = source('src/styles/comments-review.css');
    expect(css).not.toMatch(/::highlight\(comment-hl-/);
    expect(css).toContain('.comment-sand-layer');
  });

  it('documents the anchor contract with the paper comment toggle', () => {
    const doc = source('docs/editor/comment-anchors.md');
    expect(doc).toContain('## Prose anchor highlights');
    expect(doc).toContain('comment-anchor-highlight.acceptance.test.ts');
  });
});
