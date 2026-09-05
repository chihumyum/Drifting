import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = path.resolve(import.meta.dirname, '../../..');
const repoRoot = path.resolve(rendererRoot, '../..');
const source = (relative: string) => fs.readFileSync(path.join(rendererRoot, relative), 'utf8');

describe('Mobile V2 M5 complete Planning acceptance wiring', () => {
  it('mounts the full shared Timeline model in the one-level Planning surface', () => {
    const panels = source('shells/mobile/workspace/MobilePaperDeck.tsx');
    const paperTools = source('shells/mobile/workspace/MobilePaperTools.tsx');
    const timeline = source('shells/desktop/views/DesktopBottomTimeline.tsx');

    expect(panels).toContain('<BottomTimeline presentation="mobile" />');
    expect(paperTools).toContain('<PlotGridEditor');
    expect(timeline).toContain("type TimelineView = 'book' | 'narrative'");
    expect(timeline).toContain('<ActRail');
    expect(timeline).toContain('markers.map');
    expect(timeline).toContain('unplacedNodes.map');
    expect(timeline).toContain('unaffiliatedChapters');
    expect(timeline).toContain('crossStorylineLinks');
    expect(timeline).toContain('spreadTimelineNodes');
    expect(timeline).toContain('handleContextMenuAction');
    expect(timeline).toContain("data-mobile-planning={isMobilePresentation ? 'complete'");
  });

  it('uses delayed touch ownership, one compositor ghost, edge scroll, and one atomic write', () => {
    const timeline = source('shells/desktop/views/DesktopBottomTimeline.tsx');
    const drag = source('features/graph/chapter-lane-drag.ts');
    const gesture = source('features/graph/mobile-planning-gesture.ts');
    const scale = source('components/BottomTimeline/useTimelineExpandedScale.ts');
    const useCase = source('usecase/useBookNode.ts');

    expect(gesture).toContain('MOBILE_PLANNING_DRAG_ARM_MS = 180');
    expect(gesture).toContain('MOBILE_PLANNING_CONTEXT_MENU_MS = 500');
    expect(drag).toContain('resolveMobilePlanningGesture({');
    expect(drag).toContain('mobilePlanningEdgeAutoscrollDelta({');
    expect(drag).toContain("cloneNode(true)");
    expect(drag).toContain('createExactlyOnceChapterDrop(onDrop)');
    expect(timeline).toContain('mobileTouch:');
    expect(timeline).toContain('scrollContainer: scrollContainerRef.current');
    expect(timeline).toContain("'pan-x pan-y pinch-zoom'");
    expect(scale).toContain('timelinePinchAnchoredScrollLeft({');
    expect(timeline).toContain('await commitChapterLaneDrop({');
    expect(useCase).toContain('persistChapterTimelineMove({');
    expect(useCase).toContain('withOptimisticUpdate({');
  });

  it('keeps Planning out of paper swipe and gives Plot Grid complete mobile writes', () => {
    const swipe = source('shells/mobile/workspace/mobile-paper-swipe.ts');
    const grid = source('components/editor/PlotGrid.tsx');
    const css = fs.readFileSync(path.join(repoRoot, 'src/styles/mobile-workspace.css'), 'utf8');

    expect(swipe).toContain("'.btl'");
    expect(swipe).toContain("'.planner-wrap'");
    expect(grid).toContain('onPaste={(e) => handlePaste');
    expect(grid).toContain('const addRow = () =>');
    expect(grid).toContain('const addCol = () =>');
    expect(grid).toContain('const delRow = (id: string) =>');
    expect(grid).toContain('const delCol = (id: string) =>');
    expect(grid).toContain("window.addEventListener('pointercancel', cancel)");
    expect(grid).toContain('aria-label={t(\'plotGrid.resize\')}');
    expect(css).toContain('.m-plot-workspace .pl-resize-grip');
    expect(css).toContain('width: 44px');
    expect(css).toContain('font-size: 16px');
  });
});
