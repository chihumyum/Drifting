import { describe, expect, it } from 'vitest';
import { nextMobilePanelForBar } from './mobile-unified-bar-state';

describe('Mobile V2 unified bar panel cycle', () => {
  it('opens docked, promotes to full, then closes the selected side', () => {
    expect(nextMobilePanelForBar('none', 'top')).toBe('top-docked');
    expect(nextMobilePanelForBar('top-docked', 'top')).toBe('top-full');
    expect(nextMobilePanelForBar('top-full', 'top')).toBe('none');
    expect(nextMobilePanelForBar('none', 'bottom')).toBe('bottom-docked');
    expect(nextMobilePanelForBar('bottom-docked', 'bottom')).toBe('bottom-full');
    expect(nextMobilePanelForBar('bottom-full', 'bottom')).toBe('none');
  });

  it('switches sides through one canonical docked state', () => {
    expect(nextMobilePanelForBar('bottom-full', 'top')).toBe('top-docked');
    expect(nextMobilePanelForBar('top-docked', 'bottom')).toBe('bottom-docked');
  });
});
