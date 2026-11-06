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
    // The whole book counts its chapters' anchors, not its ideas'.
    expect(source('src/renderer/views/AllChaptersEditorView.tsx')).toContain("useCommentMarksToggle(projectId, 'node', null, chapterIds)");
    expect(source('src/renderer/views/AllChaptersEditorView.tsx')).toContain('new Set(orderedNodes.map((node) => node.id))');
    expect(toggle).toContain('within.has(comment.targetId)');
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

  it('lights the card of an anchor the pointer rests on in the prose', () => {
    const painter = source('src/renderer/lib/comment-sand.ts');
    // Found from the measured line boxes (the layer takes no pointer), at most once a frame.
    expect(painter).toContain("this.scrollEl.addEventListener('pointermove', this.onPointerMove);");
    expect(painter).toContain("this.scrollEl.addEventListener('pointerleave', this.onPointerLeave);");
    expect(painter).toContain('if (boxesContain(mark.boxes, pointer.x - origin.left, pointer.y - origin.top)) ids.push(mark.id);');
    expect(painter).toContain('if (event.buttons !== 0) return this.onPointerLeave();');
    expect(painter).toContain('export const POINT_INTENT_MS = 120;');
    expect(painter).toContain('createPointIntent((ids) => setPointedCommentHighlights(ids))');
    // Its swash turns as when its card is pointed at.
    expect(painter).toContain('this.activeId === comment.id || this.pointed.has(comment.id)');
    const highlights = source('src/renderer/components/editor/CommentAnchorHighlights.tsx');
    expect(highlights).toContain('painter?.update(comments, activeId, selected, pointed)');
    // With the toggle off no anchor is drawn, so the prose points at nothing.
    expect(highlights).toContain('anchored.filter((comment) => comment.id === activeId || comment.id === selected?.id)');
    // The card brings its glass in and comes into view only where its list is on screen.
    const card = source('src/renderer/features/comments/ReviewItemCard.tsx');
    expect(card).toContain('const pointed = useProsePointedCard(comment.id, articleRef);');
    expect(card).toContain("${pointed ? ' review-card--pointed' : ''}");
    const hook = source('src/renderer/features/comments/use-prose-pointed-card.ts');
    expect(hook).toContain('if (view.width === 0 || view.right <= 0 || view.left >= window.innerWidth) return;');
    expect(hook).toContain('scroller.scrollBy({ top: delta');
    expect(hook).not.toContain('scrollIntoView');
    const css = source('src/styles/comments-review.css');
    expect(css).toContain('.review-card--glass.review-card--pointed { --glass-g: 1; --glass-sp: 1; }');
    // Real line boxes and mouse input in Chromium.
    const evidence = JSON.parse(source('docs/editor/acceptance/prose-point.json')) as { status: string; checks: Record<string, boolean> };
    expect(evidence.status).toBe('passed');
    expect(Object.keys(evidence.checks)).toEqual(expect.arrayContaining([
      'waitsForIntent', 'restingPointsAtAnchor', 'pointedSwashIsHot', 'pastTheEndLetsGoAtOnce',
      'passingOverLightsNothing', 'draggingPointsAtNothing', 'followsScrolledLines', 'leavingScrollerLetsGo',
    ]));
    expect(Object.values(evidence.checks).every(Boolean)).toBe(true);
  });

  it('records the behaviour in the design system', () => {
    const components = source('docs/design-system/components.md');
    expect(components).toContain('## 批注开关与新建批注');
    expect(components).toContain('2026-11-04 起编辑器右边的便笺栏退役');
    expect(components).not.toContain('## 批注便笺');
  });
});
