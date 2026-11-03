import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const exists = (path: string) => existsSync(resolve(process.cwd(), path));

const editors: Array<[path: string, kind: string]> = [
  ['src/renderer/views/NodeEditorView.tsx', 'node'],
  ['src/renderer/views/ElementEditorView.tsx', 'element'],
  ['src/renderer/views/StorylineEditorView.tsx', 'storyline'],
  ['src/renderer/views/CategoryEditorView.tsx', 'category'],
  ['src/renderer/views/MaterialNotePage.tsx', 'library_item'],
];

describe('the paper comment toggle and composer (sticky-note rail retired 2026-11-04)', () => {
  it('removes the sticky-note rail, its session registry and the reader pinning', () => {
    for (const path of [
      'src/renderer/components/editor/StickyNoteRail.tsx',
      'src/renderer/features/comments/desktop/DesktopStickyNoteRail.tsx',
      'src/renderer/hooks/useEntityStickyNoteRail.ts',
      'src/renderer/features/share-links/reader-comment-rail.ts',
    ]) expect(exists(path), path).toBe(false);
    for (const [path] of editors) {
      const editor = source(path);
      expect(editor).not.toMatch(/StickyNoteRail|marginNotes|visibleCommentIds|editor-scroll--comments/);
    }
    expect(source('src/renderer/app/providers/ProjectRuntimeProvider.tsx')).not.toContain('reader-comment-rail');
    expect(source('src/styles/comments-review.css')).not.toMatch(/sticky-note|editor__margin/);
  });

  it('writes a selection comment in the floating composer beside it, on every entity editor', () => {
    for (const [path, kind] of editors) {
      const editor = source(path);
      expect(editor).toMatch(/onAddCommentRequest(?::|=\{) ?setPendingComment/);
      expect(editor).toMatch(new RegExp(`<EditorCommentComposer[\\s\\S]*?targetKind="${kind}"[\\s\\S]*?request=\\{pendingComment\\}`));
    }
    const composer = source('src/renderer/components/editor/EditorCommentComposer.tsx');
    expect(composer).toContain('<CommentComposer');
    expect(composer).toContain("kind: asTodo ? 'todo' : 'note'");
    expect(composer).toContain('anchorJson: request.anchorJson');
    expect(composer).toContain('request.sourceId !== targetId');
    expect(composer).toContain('selectCommentHighlight(created.id)');
    // Image and PDF regions write in the same composer.
    expect(source('src/renderer/views/MaterialEditorView.tsx')).toContain('<CommentComposer');
    expect(source('src/renderer/features/library/MaterialRegionLayer.tsx')).not.toContain('Composer');
  });

  it('turns the toolbar button into one device preference for the comment marks', () => {
    const store = source('src/renderer/store/settings-store.ts');
    expect(store).toContain('commentMarksVisible: true,');
    expect(store).toContain('setCommentMarksVisible: (on) => set({ commentMarksVisible: on }),');
    // Device-local, like the outline and reference-link toggles.
    expect(source('src/renderer/features/preference-sync/preference-fields.ts')).not.toContain('commentMarksVisible');
    const toggle = source('src/renderer/components/editor/comment-marks.ts');
    expect(toggle).toContain('state.commentMarksVisible');
    expect(toggle).toContain("comment.status === 'open'");
    for (const [path, kind] of editors.filter(([path]) => !path.endsWith('MaterialNotePage.tsx'))) {
      const editor = source(path);
      expect(editor).toContain(`useCommentMarksToggle(`);
      expect(editor).toContain(`'${kind}'`);
      expect(editor).toContain('commentToggle={commentToggle}');
    }
    expect(source('src/renderer/views/MaterialEditorView.tsx')).toContain('commentToggle={isMedia ? undefined : noteComments}');
    expect(source('src/renderer/views/AllChaptersEditorView.tsx')).toContain("useCommentMarksToggle(projectId, 'node', null)");
    const bar = source('src/renderer/components/editor/EditorTopBar.tsx');
    expect(bar).toContain("t('editorTopBar.actions.hideComments')");
    expect(bar).not.toContain('noComments');
    const zh = JSON.parse(source('src/renderer/locales/zh-CN.json')) as { editorTopBar: { actions: Record<string, string> } };
    expect(zh.editorTopBar.actions.showComments).toBe('显示批注痕迹');
    expect(zh.editorTopBar.actions.hideComments).toBe('隐藏批注痕迹');
  });

  it('draws only the pointed-at or selected anchor while the toggle is off, and drops its ticks', () => {
    const highlights = source('src/renderer/components/editor/CommentAnchorHighlights.tsx');
    expect(highlights).toContain('state.commentMarksVisible');
    expect(highlights).toContain('anchored.filter((comment) => comment.id === activeId || comment.id === selected?.id)');
    const markers = source('src/renderer/components/editor/EditorScrollMarkers.tsx');
    expect(markers).toContain('createCommentMarkerSelector(projectId, targetKind, targetId, commentMarksVisible)');
    expect(source('src/renderer/components/editor/scroll-marker-model.ts')).toContain('if (input === state.comments || !visible) return snapshot;');
  });

  it('records the behaviour in the design system', () => {
    const components = source('docs/design-system/components.md');
    expect(components).toContain('## 批注开关与新建批注');
    expect(components).toContain('2026-11-04 起编辑器右边的便笺栏退役');
    expect(components).not.toContain('## 批注便笺');
  });
});
