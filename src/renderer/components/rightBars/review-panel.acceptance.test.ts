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
    expect(source('src/renderer/store/ui-store.ts')).toContain("type ReviewScope = 'current' | 'project'");
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
    expect(
      existsSync(resolve(process.cwd(), 'src/renderer/components/rightBars/TodoPanel.tsx')),
    ).toBe(false);
  });

  it('mounts the shared Review panel in desktop and mobile right-sidebar presentations', () => {
    const desktop = source('src/renderer/shells/desktop/DesktopRightSidebar.tsx');
    const mobile = source('src/renderer/shells/mobile/workspace/MobileRightSidebar.tsx');
    const store = source('src/renderer/store/ui-store.ts');

    expect(desktop).toContain("tab === 'review'");
    // A material tab scopes Review to its region comments (docs/material-workbench.md).
    expect(desktop).toContain('<ReviewPanel focused={focusedForReview} onOpenAgentTask=');
    expect(mobile).toContain("type ToolTab = 'stats' | 'review' | 'agent' | 'library'");
    expect(mobile).toContain('<ReviewPanel focused={focused} onOpenAgentTask=');
    expect(mobile).toContain('lastMobileRightSidebarTab');
    expect(store).toContain("activeRightPanel: 'review' | 'library' | 'stats'");
    expect(store).toContain("merged.activeRightPanel as string) === 'todo'");
  });

  it('opens the mobile general sidebar from the top', () => {
    const css = source('src/styles/mobile-workspace.css');
    const sidebar = source('src/renderer/shells/mobile/workspace/MobileRightSidebar.tsx');
    const deck = source('src/renderer/shells/mobile/workspace/MobilePaperDeck.tsx');
    expect(css).toContain('inset: 0 0 0 max(8px, env(safe-area-inset-left));');
    expect(css).toContain('min-height: calc(44px + env(safe-area-inset-top));');
    expect(deck).toMatch(/<AnimatePresence>[\s\S]*?<MobileRightSidebar[\s\S]*?<\/AnimatePresence>/u);
    expect(sidebar).toContain("{ x: 28, y: '-100%' }");
    expect(sidebar).toContain("y: reducedMotion ? 0 : '-100%'");
    expect(sidebar).toContain('inert={!isPresent}');
    expect(css).not.toContain('@keyframes m-right-sidebar-enter');
  });

  it('keeps source navigation on the card header arrow', () => {
    const card = source('src/renderer/features/comments/ReviewItemCard.tsx');
    const css = source('src/styles/comments-review.css');
    const zh = source('src/renderer/locales/zh-CN.json');
    const en = source('src/renderer/locales/en.json');

    expect(card).toContain('{canJump && (');
    expect(card).toContain('className="review-card__text-link-button"');
    expect(card).toContain('onClick={jumpToAnchor}');
    expect(card).toContain('<BrushIcon name="arrow-back" size={10} />');
    expect(card).not.toContain('review-card__body--link');
    expect(css).toMatch(
      /\.review-card__text-link-button \{[\s\S]*?width: 14px;[\s\S]*?height: 14px;[\s\S]*?background: transparent;/,
    );
    expect(css).toContain('.review-card__text-link-button:focus-visible {');
    expect(zh).toContain('"jumpToText": "跳转到关联文字"');
    expect(en).toContain('"jumpToText": "Jump to linked text"');
  });

  it('reuses the flat workspace panel language on the compact radius ladder', () => {
    const panel = source('src/renderer/components/rightBars/ReviewPanel.tsx');
    const card = source('src/renderer/features/comments/ReviewItemCard.tsx');
    const css = source('src/styles/comments-review.css');
    const unifiedSurface = css.slice(css.indexOf('Unified Review panel'));

    expect(panel).toContain('className="review-panel__toolbar workspace-panel-header-row"');
    // One of several types slides a single glass slider; this-one-or-the-project
    // is a lock-like toggle whose word never changes.
    expect(panel).toContain('<GlassSlider\n          className="review-panel__type-filters"');
    // The header never wraps: when the three types don't fit beside the scope
    // toggle and the actions, they fold into one tab that opens on hover.
    expect(panel).toContain('collapsed={collapseTypeFilters}\n          onNaturalWidth={setTypeFiltersWidth}');
    expect(panel).toContain('setCollapseTypeFilters(typeFiltersWidth > room + 0.5);');
    expect(panel).toContain('<ScopeToggle\n          className="review-panel__scope-toggle"');
    expect(panel).not.toContain("t(`reviewPanel.scopes.${effectiveScope}`)");
    expect(panel).toContain('className="review-panel__list scroll-no-bar workspace-list"');
    expect(panel).not.toContain('<FilterChip');
    expect(panel).toContain('<GhostIconButton');
    expect(card).toContain("glass ? ' review-card--glass glass glass--rest glass--surface' : ' workspace-list-row glass glass--surface'");
    // No right-click menu: the item's actions ride on its source hover card.
    expect(card).not.toContain('<ContextMenuSurface');
    expect(card).not.toContain('onContextMenu=');
    expect(card).toContain('actions={actions}');
    expect(card).toContain('sourceHover.open(articleRef.current)');
    expect(card).not.toContain('<footer className="review-card__actions">');
    // The sticky-note rail is retired (2026-11-04): no card offers to pin itself.
    expect(card).not.toMatch(/sticky/i);
    expect(panel).not.toMatch(/StickyNoteRail|sticky/i);

    expect(unifiedSurface).not.toMatch(/sticky-note|review-card--sticky/);
    expect(unifiedSurface).not.toContain('.review-panel__scope-toggle {');
    expect(unifiedSurface.match(/border-radius: var\(--radius-sm\);/g)?.length).toBeGreaterThanOrEqual(2);
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
