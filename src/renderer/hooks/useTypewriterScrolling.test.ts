import { describe, expect, it, vi } from 'vitest';
import {
  createCaretRepaintCompensation,
  nextTypewriterScrollTop,
  normalizeTypewriterPosition,
  typewriterTailSpace,
} from './useTypewriterScrolling';
import { normalizeCaretColor } from '../store/settings-store';

describe('typewriter scrolling geometry', () => {
  it('normalizes synchronized caret colors', () => {
    expect(normalizeCaretColor('#A1B2C3')).toBe('#a1b2c3');
    expect(normalizeCaretColor('red')).toBe('#6b7fa6');
    expect(normalizeCaretColor(null)).toBe('#6b7fa6');
  });

  it('normalizes persisted positions into the supported viewport range', () => {
    expect(normalizeTypewriterPosition(Number.NaN)).toBe(50);
    expect(normalizeTypewriterPosition(10)).toBe(25);
    expect(normalizeTypewriterPosition(61.6)).toBe(62);
    expect(normalizeTypewriterPosition(90)).toBe(75);
  });

  it('adds enough visual tail space for the selected caret anchor', () => {
    expect(typewriterTailSpace(800, 25)).toBe(624);
    expect(typewriterTailSpace(800, 50)).toBe(424);
    expect(typewriterTailSpace(800, 75)).toBe(224);
  });

  it('moves the caret center to the configured viewport position', () => {
    expect(
      nextTypewriterScrollTop({
        scrollTop: 300,
        scrollHeight: 2400,
        viewportHeight: 800,
        viewportTop: 100,
        caretTop: 590,
        caretBottom: 610,
        position: 50,
      }),
    ).toBe(400);
  });

  it('respects the natural document start and the virtual document end', () => {
    expect(
      nextTypewriterScrollTop({
        scrollTop: 0,
        scrollHeight: 1600,
        viewportHeight: 800,
        viewportTop: 100,
        caretTop: 140,
        caretBottom: 160,
        position: 50,
      }),
    ).toBe(0);
    expect(
      nextTypewriterScrollTop({
        scrollTop: 760,
        scrollHeight: 1600,
        viewportHeight: 800,
        viewportTop: 100,
        caretTop: 1000,
        caretBottom: 1020,
        position: 50,
      }),
    ).toBe(800);
  });

  it('hides the native caret for one scroll paint, then restores it', () => {
    const element = {
      setAttribute: vi.fn(),
      removeAttribute: vi.fn(),
    };
    const callbacks = new Map<number, FrameRequestCallback>();
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      const handle = callbacks.size + 1;
      callbacks.set(handle, callback);
      return handle;
    });
    const cancelFrame = vi.fn((handle: number) => callbacks.delete(handle));
    const compensation = createCaretRepaintCompensation(
      element,
      requestFrame,
      cancelFrame,
    );

    compensation.beforeScroll();

    expect(element.setAttribute).toHaveBeenCalledWith(
      'data-typewriter-caret-repaint',
      'on',
    );
    expect(element.removeAttribute).not.toHaveBeenCalled();

    callbacks.get(1)?.(0);
    expect(element.removeAttribute).toHaveBeenCalledWith(
      'data-typewriter-caret-repaint',
    );
  });

  it('cancels stale caret restoration during consecutive scrolls', () => {
    const element = {
      setAttribute: vi.fn(),
      removeAttribute: vi.fn(),
    };
    let nextHandle = 0;
    const requestFrame = vi.fn(() => {
      nextHandle += 1;
      return nextHandle;
    });
    const cancelFrame = vi.fn();
    const compensation = createCaretRepaintCompensation(
      element,
      requestFrame,
      cancelFrame,
    );

    compensation.beforeScroll();
    compensation.beforeScroll();
    compensation.dispose();

    expect(cancelFrame).toHaveBeenNthCalledWith(1, 1);
    expect(cancelFrame).toHaveBeenNthCalledWith(2, 2);
    expect(element.removeAttribute).toHaveBeenCalledWith(
      'data-typewriter-caret-repaint',
    );
  });
});
