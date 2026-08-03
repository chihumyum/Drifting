import { describe, expect, it, vi } from 'vitest';
import {
  dispatchSuperViewEscape,
  resolveTopSuperViewEscapeLayer,
  type SuperViewEscapeLayer,
} from './useSuperViewEscapeStack';

function layer(id: string, active = true): SuperViewEscapeLayer {
  return { id, active, onEscape: vi.fn() };
}

describe('Super View Escape stack', () => {
  it('returns the most recently opened active layer', () => {
    const driftPanel = layer('drift-panel');
    const popover = layer('popover');

    expect(
      resolveTopSuperViewEscapeLayer(
        [driftPanel, popover],
        new Map([
          ['drift-panel', 1],
          ['popover', 2],
        ]),
      ),
    ).toBe(popover);
  });

  it('ignores a newer layer after it becomes inactive', () => {
    const driftPanel = layer('drift-panel');
    const popover = layer('popover', false);

    expect(
      resolveTopSuperViewEscapeLayer(
        [driftPanel, popover],
        new Map([
          ['drift-panel', 1],
          ['popover', 2],
        ]),
      ),
    ).toBe(driftPanel);
  });

  it('returns null at the Super View root', () => {
    expect(resolveTopSuperViewEscapeLayer([layer('drawer', false)], new Map())).toBeNull();
  });

  it('dispatches exactly one child action and does not exit the root', () => {
    const rootBack = vi.fn();
    const driftPanel = layer('drift-panel');
    const popover = layer('popover');

    expect(
      dispatchSuperViewEscape(
        [driftPanel, popover],
        new Map([
          ['drift-panel', 1],
          ['popover', 2],
        ]),
        rootBack,
      ),
    ).toBe('popover');
    expect(popover.onEscape).toHaveBeenCalledOnce();
    expect(driftPanel.onEscape).not.toHaveBeenCalled();
    expect(rootBack).not.toHaveBeenCalled();
  });

  it('returns to the previous editor surface from the root', () => {
    const rootBack = vi.fn();

    expect(dispatchSuperViewEscape([], new Map(), rootBack)).toBe('root');
    expect(rootBack).toHaveBeenCalledOnce();
  });
});
