import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('unified Review surface acceptance', () => {
  it('uses one comment domain for comments, Copilot items, and TODOs', () => {
    const panel = source('src/renderer/components/rightBars/ReviewPanel.tsx');
    const card = source('src/renderer/features/comments/ReviewItemCard.tsx');
    const domain = source('src/renderer/domain/comment.ts');
    const useComment = source('src/renderer/usecase/useComment.ts');
    const toolRegistry = source('src/renderer/lib/agent/tool-registry.ts');

    expect(panel).toContain("type ReviewTypeFilter = 'all' | 'comment' | 'todo'");
    expect(panel).toContain("type ReviewScope = 'current' | 'project'");
    expect(panel).toContain("comment.kind === 'todo'");
    expect(panel).toContain("comment.kind !== 'todo'");
    expect(panel).toContain('commentBelongsToEntity');
    expect(card).toContain('convertToTodo(comment.id)');
    expect(card).toContain('revertToNote(comment.id)');
    expect(domain).toContain("export type CommentKind = 'note' | 'todo';");
    expect(domain).not.toContain("'exception'");
    expect(card).not.toContain('markException');
    expect(useComment).not.toContain('setCommentKind');
    expect(toolRegistry).not.toContain("Type.Literal('exception')");
    expect(panel).toContain('const structuralRelations = (refsByComment.get(comment.id) ?? [])');
    expect(panel).toContain('navigator.open({ entityType: target.kind, id: target.id })');
    expect(
      existsSync(resolve(process.cwd(), 'src/renderer/components/rightBars/TodoPanel.tsx')),
    ).toBe(false);
  });

  it('mounts the shared Review panel in desktop and mobile right-sidebar presentations', () => {
    const desktop = source('src/renderer/shells/desktop/DesktopRightSidebar.tsx');
    const mobile = source('src/renderer/shells/mobile/workspace/MobileRightSidebar.tsx');
    const store = source('src/renderer/store/ui-store.ts');

    expect(desktop).toContain("activeRightPanel === 'review'");
    expect(desktop).toContain('<ReviewPanel focused={focusedForPanel} />');
    expect(mobile).toContain("type ToolTab = 'planning' | 'review' | 'agent' | 'library'");
    expect(mobile).toContain('<ReviewPanel focused={focused} />');
    expect(mobile).toContain('lastMobileRightSidebarTab');
    expect(store).toContain("activeRightPanel: 'review' | 'library' | 'stats'");
    expect(store).toContain("merged.activeRightPanel as string) === 'todo'");
  });

  it('marks text-linked Review rows with a small clickable left arrow', () => {
    const card = source('src/renderer/features/comments/ReviewItemCard.tsx');
    const css = source('src/styles/comments-review.css');
    const zh = source('src/renderer/locales/zh-CN.json');
    const en = source('src/renderer/locales/en.json');

    expect(card).toContain('ArrowLeft,');
    expect(card).toContain("presentation === 'panel' && canJump && (");
    expect(card).toContain('className="review-card__text-link-button"');
    expect(card).toContain('onClick={jumpToAnchor}');
    expect(card).toContain('<ArrowLeft size={10} strokeWidth={1.8} aria-hidden />');
    expect(card).toContain('className="review-card__body review-card__body--link" onClick={jumpToAnchor}');
    expect(css).toMatch(
      /\.review-card__text-link-button \{[\s\S]*?width: 14px;[\s\S]*?height: 14px;[\s\S]*?background: transparent;/,
    );
    expect(css).toContain('.review-card__text-link-button:focus-visible {');
    expect(zh).toContain('"jumpToText": "跳转到关联文字"');
    expect(en).toContain('"jumpToText": "Jump to linked text"');
  });

  it('reuses the flat workspace panel language and keeps sticky notes on the compact radius ladder', () => {
    const panel = source('src/renderer/components/rightBars/ReviewPanel.tsx');
    const card = source('src/renderer/features/comments/ReviewItemCard.tsx');
    const rail = source('src/renderer/components/editor/StickyNoteRail.tsx');
    const css = source('src/styles/comments-review.css');
    const unifiedSurface = css.slice(css.indexOf('Unified Review panel + explicit sticky-note rail'));

    expect(panel).toContain('className="review-panel__toolbar workspace-panel-header-row"');
    expect(panel).toContain('className="review-panel__scope-toggle"');
    expect(panel).not.toContain('left-panel-view-mode-text review-panel__scope-toggle');
    expect(panel).toContain('className="review-panel__list scroll-no-bar workspace-list"');
    expect(panel).toContain('<FilterChip');
    expect(panel).toContain('<GhostIconButton');
    expect(card).toContain("presentation === 'panel' ? ' workspace-list-row' : ''");
    expect(card).toContain('<ContextMenuSurface');
    expect(card).not.toContain('<footer className="review-card__actions">');
    expect(rail).toContain('<GhostIconButton');

    expect(unifiedSurface).toContain('.review-card--sticky {');
    expect(unifiedSurface).toContain('.sticky-note-stack {');
    expect(unifiedSurface).toMatch(
      /\.review-panel__scope-toggle \{[\s\S]*?min-height: 20px;[\s\S]*?padding: 2px 4px;[\s\S]*?font: 9\.5px\/1 var\(--font-mono\);/,
    );
    expect(unifiedSurface.match(/border-radius: var\(--radius-sm\);/g)?.length).toBeGreaterThanOrEqual(4);
    expect(unifiedSurface).not.toContain('border-radius: 5px;');
    expect(unifiedSurface).not.toContain('border-radius: 7px;');
    expect(unifiedSurface).not.toContain('background-image:');
    expect(unifiedSurface).not.toContain('box-shadow: 0 12px');
  });

  it('deletes a review item and its generic relations in one optimistic transaction', () => {
    const useComment = source('src/renderer/usecase/useComment.ts');
    const deleteStart = useComment.indexOf('const deleteComment = useCallback');
    const deleteEnd = useComment.indexOf('const convertToTodo = useCallback', deleteStart);
    const deletion = useComment.slice(deleteStart, deleteEnd);

    expect(deletion).toContain("withoutRelationsForEntity(");
    expect(deletion).toContain("'comment',");
    expect(deletion).toContain('state.setEntityRelations(remainingRelations)');
    expect(deletion).toContain('setEntityRelations(relations)');
    expect(deletion).toContain('deleteEntityRelationsInTransaction');
    expect(deletion.indexOf('deleteEntityRelationsInTransaction')).toBeLessThan(
      deletion.indexOf('createCommentRepository(projectId, tx).delete(id)'),
    );
    expect(deletion).toContain("events.emit('comment:deleted', { commentId: id })");
  });
});
