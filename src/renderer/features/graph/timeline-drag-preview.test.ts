import { describe, expect, it, vi } from 'vitest';
import { createTimelineDragPreview } from './timeline-drag-preview';

function setup() {
  let sequence = 0;
  const tasks = new Map<number, () => void>();
  const clock = {
    requestFrame: (callback: () => void) => { tasks.set(++sequence, callback); return sequence; },
    cancelFrame: (id: number) => { tasks.delete(id); },
  };
  return { preview: createTimelineDragPreview(clock), pending: () => tasks.size,
    frame() { const callbacks = [...tasks.values()]; tasks.clear(); callbacks.forEach((callback) => callback()); } };
}

describe('timeline preview publication', () => {
  it('publishes only the latest marker and act coordinates once per frame, without mutating an earlier snapshot', () => {
    const { preview, pending, frame } = setup(); const changed = vi.fn(); preview.subscribe(changed);
    const empty = preview.getSnapshot();
    for (let x = 0; x < 100; x++) { preview.setMarker('marker', x + 0.25); preview.setAct(x + 0.75); }
    expect(pending()).toBe(1); expect(preview.getSnapshot()).toBe(empty); expect(changed).not.toHaveBeenCalled();
    frame(); const before = preview.getSnapshot();
    expect(before).toEqual({ markerXs: { marker: 99.25 }, actX: 99.75 }); expect(changed).toHaveBeenCalledTimes(1);
    preview.setMarker('marker', 99.25); preview.setAct(99.75); expect(pending()).toBe(0);
    preview.setMarker('marker', 101); frame();
    expect(before.markerXs.marker).toBe(99.25); expect(Object.isFrozen(before.markerXs)).toBe(true);
  });

  it('clears immediately before a display frame and does not resurrect a cancelled drag', () => {
    const { preview, pending, frame } = setup(); const changed = vi.fn(); preview.subscribe(changed);
    preview.setMarker('__proto__', 10); frame();
    expect(preview.getSnapshot().markerXs.__proto__).toBe(10);
    preview.setMarker('__proto__', 20); preview.setMarker('__proto__', null);
    expect(pending()).toBe(0); expect(preview.getSnapshot().markerXs).toEqual({});
    expect(changed).toHaveBeenCalledTimes(2); frame(); expect(changed).toHaveBeenCalledTimes(2);
    preview.setAct(5); preview.setAct(null); frame(); expect(changed).toHaveBeenCalledTimes(2);
  });

  it('retains another active marker, releases after the last subscriber, and allows StrictMode resubscription', () => {
    const { preview, pending, frame } = setup(); const a = vi.fn(); const b = vi.fn();
    const offA = preview.subscribe(a); const offB = preview.subscribe(b);
    preview.setMarker('a', 1); preview.setMarker('b', 2); frame();
    preview.setMarker('a', null); expect(preview.getSnapshot().markerXs).toEqual({ b: 2 });
    offA(); preview.setMarker('b', 3); expect(pending()).toBe(1);
    offB(); expect(pending()).toBe(0); expect(preview.getSnapshot()).toEqual({ markerXs: {}, actX: null });
    const calls = b.mock.calls.length; frame(); expect(b).toHaveBeenCalledTimes(calls);
    const off = preview.subscribe(b); preview.setAct(4); frame(); expect(preview.getSnapshot().actX).toBe(4); off();
  });

  it('keeps independently mounted timelines isolated', () => {
    const a = setup(); const b = setup(); a.preview.subscribe(() => {}); b.preview.subscribe(() => {});
    a.preview.setMarker('same-id', 1); b.preview.setMarker('same-id', 2); a.frame(); b.frame();
    a.preview.setMarker('same-id', null); expect(b.preview.getSnapshot().markerXs['same-id']).toBe(2);
  });
});
