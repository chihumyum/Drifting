import { describe, expect, it } from 'vitest';
import { resolveMobilePanelGesture } from './mobile-panel-gesture';

describe('resolveMobilePanelGesture', () => {
  it('preserves the exact author-controlled extent after an ordinary drag', () => {
    expect(
      resolveMobilePanelGesture({
        extent: 0.72,
        openingVelocityVhPerSecond: 0.18,
        travel: 0.42,
        viewportHeightPx: 844,
      }),
    ).toEqual({ state: 'docked', extent: 0.72 });
  });

  it('does not turn a slow threshold crossing into full screen', () => {
    expect(
      resolveMobilePanelGesture({
        extent: 0.51,
        openingVelocityVhPerSecond: 0.08,
        travel: 0.23,
        viewportHeightPx: 844,
      }),
    ).toEqual({ state: 'docked', extent: 0.51 });
  });

  it('opens full screen only at the physical edge or after a deliberate fling', () => {
    expect(
      resolveMobilePanelGesture({
        extent: 0.99,
        openingVelocityVhPerSecond: 0,
        travel: 0.2,
        viewportHeightPx: 844,
      }),
    ).toEqual({ state: 'full', extent: 1 });
    expect(
      resolveMobilePanelGesture({
        extent: 0.44,
        openingVelocityVhPerSecond: 1.5,
        travel: 0.16,
        viewportHeightPx: 844,
      }),
    ).toEqual({ state: 'full', extent: 1 });
  });

  it('requires meaningful travel before velocity can fling a panel', () => {
    expect(
      resolveMobilePanelGesture({
        extent: 0.18,
        openingVelocityVhPerSecond: 3,
        travel: 0.03,
        viewportHeightPx: 844,
      }),
    ).toEqual({ state: 'docked', extent: 0.18 });
  });

  it('snaps closed inside the 144px edge zone and preserves taller releases', () => {
    const viewportHeightPx = 844;
    expect(
      resolveMobilePanelGesture({
        extent: 144 / viewportHeightPx,
        openingVelocityVhPerSecond: 0,
        travel: 0.3,
        viewportHeightPx,
      }),
    ).toEqual({ state: 'closed', extent: 0 });
    expect(
      resolveMobilePanelGesture({
        extent: 145 / viewportHeightPx,
        openingVelocityVhPerSecond: 0,
        travel: 0.3,
        viewportHeightPx,
      }),
    ).toEqual({ state: 'docked', extent: 145 / viewportHeightPx });
  });

  it('also closes after a deliberate closing fling', () => {
    expect(
      resolveMobilePanelGesture({
        extent: 0.36,
        openingVelocityVhPerSecond: -1.4,
        travel: 0.14,
        viewportHeightPx: 844,
      }),
    ).toEqual({ state: 'closed', extent: 0 });
  });
});
