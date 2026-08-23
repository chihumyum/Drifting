import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = path.resolve(import.meta.dirname, '../../..');
const repoRoot = path.resolve(rendererRoot, '../..');
const source = (relative: string) => fs.readFileSync(path.join(rendererRoot, relative), 'utf8');

describe('Mobile V2 M7 independent Super View acceptance wiring', () => {
  it('captures one immutable paper return point and never recaptures while switching', () => {
    const shell = source('shells/mobile/MobileAppShell.tsx');
    const returnPoint = source('shells/mobile/workspace/mobile-super-view-state.ts');

    expect(shell).toContain('if (activeSuperView === null)');
    expect(shell).toContain('captureMobileSuperViewReturnPoint');
    expect(shell).toContain('mobileSuperViewReturnPointMatches');
    expect(shell).toContain('lastSuperViewRestoreStatus');
    expect(shell).toContain("dispatchWorkspaceUi({ type: 'show-super-view', view })");
    expect(returnPoint).toContain('paperKeys: session.papers.map((paper) => paper.key)');
    expect(returnPoint).toContain('returnPoint.location.pathname !== location.pathname');
    expect(returnPoint).toContain('returnPoint.location.search !== location.search');
    expect(returnPoint).toContain('returnPoint.location.hash !== location.hash');
  });

  it('isolates the mounted paper and makes the full-screen host own gestures and focus', () => {
    const deck = source('shells/mobile/workspace/MobilePaperDeck.tsx');
    const host = source('shells/mobile/workspace/MobileSuperViewHost.tsx');
    const swipe = source('shells/mobile/workspace/mobile-paper-swipe.ts');
    const css = fs.readFileSync(path.join(repoRoot, 'src/styles/mobile-workspace.css'), 'utf8');

    expect(deck).toContain("inert={workspaceUi.surface.kind !== 'paper'}");
    expect(deck).toContain("aria-hidden={workspaceUi.surface.kind !== 'paper' ? 'true' : undefined}");
    expect(host).toContain('role="dialog"');
    expect(host).toContain('aria-modal="true"');
    expect(host).toContain('data-gesture-owner="super-view"');
    expect(host).toContain("previous.focus({ preventScroll: true })");
    expect(swipe).toContain("workspace.surface.kind === 'paper'");
    expect(css).toContain("html[data-shell-mode='mobile'] .m-super-view-host .super-view-overlay");
    expect(css).toContain('overscroll-behavior: none');
  });

  it('keeps all three views in one independent header without paper navigation', () => {
    const host = source('shells/mobile/workspace/MobileSuperViewHost.tsx');
    const header = source('shells/desktop/components/DesktopSuperViewHeader.tsx');

    expect(host).toContain("active === 'element' && <SuperElementView />");
    expect(host).toContain("active === 'graph' && <StoryGraphView />");
    expect(host).toContain("active === 'memo-material' && <SuperMemoMaterialView />");
    expect(header).toContain("{ id: 'element'");
    expect(header).toContain("{ id: 'graph'");
    expect(header).toContain("{ id: 'memo-material'");
    expect(host).not.toMatch(/MobilePaper|navigator\.open|navigate\(/);
  });

  it('provides touch canvas ownership, midpoint pinch, node drag, and explicit relations', () => {
    const element = source('shells/desktop/views/DesktopSuperElementView.tsx');
    const graph = source('shells/desktop/views/DesktopStoryGraphView.tsx');
    const gesture = source('features/graph/super-view-canvas-gesture.ts');
    const html = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');

    expect(element).toContain('beginSuperViewPinch');
    expect(element).toContain('updateSuperViewPinch');
    expect(element).toContain("touchAction: 'none'");
    expect(element).toContain("'[data-super-card]'");
    expect(graph).toContain('startGraphChapterPointerDrag(event, node)');
    expect(graph).toContain('if (!mobileLinkMode)');
    expect(element).toContain('m-super-view-link-mode');
    expect(graph).toContain('m-super-view-link-mode');
    expect(gesture).toContain('same authored world point beneath the moving two-finger midpoint');
    expect(html).toContain('maximum-scale=1.0, user-scalable=no');
  });

  it('keeps Memo and Material actions reachable without hover or right click', () => {
    const memo = source('shells/desktop/views/DesktopSuperMemoMaterialView.tsx');
    const card = source('features/library/LibraryItemCard.tsx');

    expect(memo.match(/mobileActions=\{mobileShell\}/g)).toHaveLength(2);
    expect(card).toContain('className="library-item-card__mobile-menu"');
    expect(card).toContain('createPortal(');
  });
});
