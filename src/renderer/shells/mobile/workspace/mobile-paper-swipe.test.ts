import { describe, expect, it } from 'vitest';
import {
  createInitialMobileWorkspaceUiState,
  mobileWorkspaceReducer,
} from './mobile-workspace-controller';
import {
  MOBILE_PAPER_SWIPE_AXIS_LOCK_PX,
  canStartMobilePaperSwipe,
  mobilePaperSwipeDistanceThreshold,
  resolveMobilePaperSwipe,
} from './mobile-paper-swipe';

describe('Mobile V2 paper swipe arbitration', () => {
  const root = mobileWorkspaceReducer(createInitialMobileWorkspaceUiState(), {
    type: 'show-paper',
  });

  it('starts only from the read-paper root with no competing owner', () => {
    expect(
      canStartMobilePaperSwipe({
        workspace: root,
        activeRail: null,
        selectionCollapsed: true,
        composing: false,
      }),
    ).toBe(true);

    for (const environment of [
      { workspace: { ...root, paperMode: { kind: 'edit', accessory: 'navigation' } as const } },
      { workspace: { ...root, panel: 'top-docked' as const } },
      { workspace: { ...root, transient: { kind: 'search', scope: 'paper' } as const } },
      { workspace: { ...root, surface: { kind: 'overview', returnTo: 'paper' } as const } },
    ]) {
      expect(
        canStartMobilePaperSwipe({
          workspace: environment.workspace,
          activeRail: null,
          selectionCollapsed: true,
          composing: false,
        }),
      ).toBe(false);
    }
    expect(
      canStartMobilePaperSwipe({
        workspace: root,
        activeRail: 'comments',
        selectionCollapsed: true,
        composing: false,
      }),
    ).toBe(false);
    expect(
      canStartMobilePaperSwipe({
        workspace: root,
        activeRail: null,
        selectionCollapsed: false,
        composing: false,
      }),
    ).toBe(false);
  });

  it('uses the frozen axis lock and dominant-axis ratio', () => {
    expect(
      resolveMobilePaperSwipe({
        deltaX: MOBILE_PAPER_SWIPE_AXIS_LOCK_PX - 1,
        deltaY: 0,
        durationMs: 100,
        viewportWidth: 390,
        originIndex: 1,
        paperCount: 3,
      }).axis,
    ).toBe('pending');
    expect(
      resolveMobilePaperSwipe({
        deltaX: 20,
        deltaY: 19,
        durationMs: 100,
        viewportWidth: 390,
        originIndex: 1,
        paperCount: 3,
      }).axis,
    ).toBe('vertical');
  });

  it('clamps the distance threshold to 72px through 96px', () => {
    expect(mobilePaperSwipeDistanceThreshold(320)).toBe(72);
    expect(mobilePaperSwipeDistanceThreshold(390)).toBe(85.8);
    expect(mobilePaperSwipeDistanceThreshold(1024)).toBe(96);
  });

  it('commits distance and velocity paths to one adjacent paper', () => {
    expect(
      resolveMobilePaperSwipe({
        deltaX: -90,
        deltaY: 8,
        durationMs: 320,
        viewportWidth: 390,
        originIndex: 1,
        paperCount: 4,
      }),
    ).toMatchObject({ axis: 'horizontal', committed: true, direction: 1, targetIndex: 2 });
    expect(
      resolveMobilePaperSwipe({
        deltaX: 48,
        deltaY: 2,
        durationMs: 90,
        viewportWidth: 390,
        originIndex: 2,
        paperCount: 4,
      }),
    ).toMatchObject({ axis: 'horizontal', committed: true, direction: -1, targetIndex: 1 });
  });

  it('settles back for short slow drags and cannot run past either edge', () => {
    expect(
      resolveMobilePaperSwipe({
        deltaX: -40,
        deltaY: 2,
        durationMs: 400,
        viewportWidth: 390,
        originIndex: 1,
        paperCount: 3,
      }),
    ).toMatchObject({ committed: false, targetIndex: 1 });
    expect(
      resolveMobilePaperSwipe({
        deltaX: 120,
        deltaY: 0,
        durationMs: 180,
        viewportWidth: 390,
        originIndex: 0,
        paperCount: 3,
      }),
    ).toMatchObject({ committed: false, targetIndex: 0 });
  });
});
