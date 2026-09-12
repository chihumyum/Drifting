import { describe, expect, it, vi } from 'vitest';
import { createGraphGeometryScheduler } from './graph-geometry-scheduler';

function frameClock() {
  let now = 0; let sequence = 0;
  const callbacks = new Map<number, () => void>();
  return { now: () => now,
    requestFrame: (callback: () => void) => { callbacks.set(++sequence, callback); return sequence; },
    cancelFrame: (id: number) => { callbacks.delete(id); }, pending: () => callbacks.size,
    frame(time: number) { now = time; const tasks = [...callbacks.values()]; callbacks.clear(); tasks.forEach((task) => task()); } };
}

describe('graph geometry frame scheduler', () => {
  it('coalesces event bursts with animation frames and stops at the finite deadline', () => {
    const clock = frameClock(); const measure = vi.fn();
    const scheduler = createGraphGeometryScheduler(measure, 600, clock);
    for (let i = 0; i < 100; i++) scheduler.invalidate();
    expect(clock.pending()).toBe(1);
    clock.frame(16);
    expect(measure).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 100; i++) scheduler.invalidate();
    expect(clock.pending()).toBe(1);
    clock.frame(600);
    expect(measure).toHaveBeenCalledTimes(2);
    expect(clock.pending()).toBe(0);
    scheduler.invalidate(); clock.frame(800);
    expect(measure).toHaveBeenCalledTimes(3);
    expect(clock.pending()).toBe(0);
    scheduler.dispose();
  });

  it('measures once after a suspended animation frame resumes beyond the deadline', () => {
    const clock = frameClock(); const measure = vi.fn();
    createGraphGeometryScheduler(measure, 600, clock);
    clock.frame(10_000);
    expect(measure).toHaveBeenCalledTimes(1);
    expect(clock.pending()).toBe(0);
  });

  it('cancels scheduled work and rejects later invalidations after disposal', () => {
    const clock = frameClock(); const measure = vi.fn();
    const scheduler = createGraphGeometryScheduler(measure, 0, clock);
    scheduler.dispose(); scheduler.dispose(); scheduler.invalidate(); clock.frame(16);
    expect(measure).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(0);
  });
});
