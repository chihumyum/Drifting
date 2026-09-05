import { describe, expect, it } from 'vitest';
import { InputActionGesture } from './useInputPreservingActions';

describe('input accessory press arbitration', () => {
  it('activates once at release, allowing normal finger jitter', () => {
    const gesture = new InputActionGesture<string>();
    gesture.start(1, 100, 20, 'bold');
    gesture.move(1, 103, 22);
    expect(gesture.finish(104, 23)).toBe('bold');
    expect(gesture.finish(104, 23)).toBeNull();
  });

  it('does not format when a horizontal swipe returns to its starting button', () => {
    const gesture = new InputActionGesture<string>();
    gesture.start(1, 100, 20, 'heading');
    gesture.move(1, 50, 20);
    gesture.move(1, 100, 20);
    expect(gesture.finish(100, 20)).toBeNull();
  });

  it('rejects a distant release even when no move event was delivered', () => {
    const gesture = new InputActionGesture<string>();
    gesture.start(1, 100, 20, 'undo');
    expect(gesture.finish(150, 20)).toBeNull();
  });

  it('lets native scrolling cancel a tap and admits the next independent tap', () => {
    const gesture = new InputActionGesture<string>();
    gesture.start(1, 100, 20, 'heading');
    gesture.cancel();
    expect(gesture.finish(100, 20)).toBeNull();
    gesture.start(2, 100, 20, 'italic');
    expect(gesture.finish(100, 20)).toBe('italic');
  });

  it('does not treat vertical movement as a button activation', () => {
    const gesture = new InputActionGesture<string>();
    gesture.start(1, 100, 20, 'send');
    gesture.move(1, 100, 60);
    expect(gesture.finish(100, 20)).toBeNull();
  });

  it('ignores movement belonging to a different pointer', () => {
    const gesture = new InputActionGesture<string>();
    gesture.start(1, 100, 20, 'config');
    gesture.move(2, 200, 20);
    expect(gesture.finish(100, 20)).toBe('config');
  });
});
