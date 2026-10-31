import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { afterEditorStageReady, announceEditorStageReady, resetEditorStageReady } from './editor-stage-ready';

describe('background work waiting for the page in front', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetEditorStageReady();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs a moment after the stage first shows its page', () => {
    const work = vi.fn();
    afterEditorStageReady(work, 3000);
    vi.advanceTimersByTime(1000);
    expect(work).not.toHaveBeenCalled();
    announceEditorStageReady();
    vi.advanceTimersByTime(249);
    expect(work).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(work).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('runs at the limit if the stage never reports, and at once without a stage', () => {
    const late = vi.fn();
    afterEditorStageReady(late, 3000);
    vi.advanceTimersByTime(3000);
    expect(late).toHaveBeenCalledTimes(1);
    const mobile = vi.fn();
    afterEditorStageReady(mobile, 0);
    vi.advanceTimersByTime(0);
    expect(mobile).toHaveBeenCalledTimes(1);
  });

  it('does not count a stage that was ready before this book began to open, and can be called off', () => {
    announceEditorStageReady();
    const already = vi.fn();
    afterEditorStageReady(already, 3000);
    vi.advanceTimersByTime(250);
    expect(already).toHaveBeenCalledTimes(1);

    resetEditorStageReady();
    const next = vi.fn();
    afterEditorStageReady(next, 3000);
    vi.advanceTimersByTime(250);
    expect(next).not.toHaveBeenCalled();

    const cancelled = vi.fn();
    afterEditorStageReady(cancelled, 3000)();
    announceEditorStageReady();
    vi.advanceTimersByTime(3000);
    expect(cancelled).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
