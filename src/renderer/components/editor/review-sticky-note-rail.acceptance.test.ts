import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('Review panel and sticky-note rail acceptance', () => {
  it('mounts the sticky rail as a viewport overlay beside every entity editor', () => {
    const editors = [
      'src/renderer/views/NodeEditorView.tsx',
      'src/renderer/views/ElementEditorView.tsx',
      'src/renderer/views/StorylineEditorView.tsx',
      'src/renderer/views/CategoryEditorView.tsx',
    ];

    for (const path of editors) {
      const editor = source(path);
      expect(editor).toContain('useEntityStickyNoteRail');
      expect(editor).toMatch(
        /className=[^\n]*editor-scroll[\s\S]*?<div className="editor__spread">[\s\S]*?<\/div>\s*<\/div>\s*\{marginNotes && \(\s*<StickyNoteRail/,
      );
    }
  });

  it('renders only explicit session membership and removes per-card collapse state', () => {
    const rail = source('src/renderer/components/editor/StickyNoteRail.tsx');
    const registry = source('src/renderer/hooks/useEntityStickyNoteRail.ts');

    expect(rail).toContain('rail.itemIds.flatMap');
    expect(rail).toContain("rail.layout === 'stacked'");
    expect(rail).toContain('onRemoveFromStickyRail');
    expect(rail).toContain('onClick={rail.clear}');
    expect(rail).not.toContain('commentBelongsToEntity');
    expect(rail).not.toContain('collapsedCommentIds');
    expect(registry).toContain('const stickyNoteRailValues = new Map');
    expect(registry).toContain('itemIds: [commentId, ...current.itemIds.filter');
    expect(registry).not.toContain('localStorage');
  });

  it('keeps the mobile rail transparent and opens the general sidebar from the top', () => {
    const css = source('src/styles/mobile-workspace.css');
    const openRuleStart = css.indexOf(
      ".m-workspace[data-rail-comments='true'] .editor__margin {",
    );
    const openRuleEnd = css.indexOf('\n}', openRuleStart);
    const openRule = css.slice(openRuleStart, openRuleEnd);

    expect(openRuleStart).toBeGreaterThanOrEqual(0);
    expect(openRule).toContain('background: transparent;');
    expect(openRule).not.toContain('linear-gradient');
    expect(css).toContain('@keyframes m-right-sidebar-enter');
    expect(css).toContain('transform: translateY(-34px);');
    expect(css).not.toMatch(/\.m-tools-face\.m-right-sidebar[\s\S]*translateX/);
  });

  it('records the cross-platform behavior and validation boundary durably', () => {
    const evidence = source('docs/qa/review-sticky-note-rail-2026-08-30.md');

    expect(evidence).toContain('Review is the only project review list');
    expect(evidence).toContain('session-only');
    expect(evidence).toContain('No Simulator, physical-device touch');
  });
});
