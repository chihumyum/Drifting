import { createElement, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { TimelinePin } from '../components/timeline/TimelinePin';
import { ActRail } from '../components/BottomTimeline/ActRail';
import { TimelineMarkerLines, TimelineActDragLine } from '../components/timeline/TimelineGuideLines';
import { createTimelineDragPreview } from '../features/graph/timeline-drag-preview';
import type { BookAct } from '../domain/book-act';
import bottomStyles from '../../styles/bottom-timeline.css?raw';
import graphStyles from '../../styles/graph-view.css?raw';
import type { TimelineMarker } from '../domain/timeline-marker';
import { projectVerticalTimeline } from '../shells/mobile/workspace/timeline/vertical-timeline-projection';
import { projectVerticalTimelineLeaders } from '../shells/mobile/workspace/timeline/vertical-timeline-leaders';

const layout = { gutterWidth: 108, trackX0: 16, trackStep: 15, channelOffset: 4, entryOffset: 12 };
async function leadersScenario() {
  const profiles = [];
  for (const count of [100, 1_000, 5_000]) {
    let reads = 0; let counting = true;
    const chapters = Array.from({ length: count }, (_, index) => ({
      get id() { if (counting) reads++; return `synthetic-chapter-${index}`; }, trackIndex: index % 6,
    }));
    const entries = projectVerticalTimeline(Array.from({ length: count }, (_, index) => ({ id: `synthetic-chapter-${index}`, kind: 'chapter', y: index * 150 })));
    const first = projectVerticalTimelineLeaders(entries, chapters, layout);
    const firstIdReads = reads; reads = 0;
    const pathsMatchFixture = first.every((line, index) => line.bracket === null && line.id === `synthetic-chapter-${index}`
      && line.points === `${16 + 15 * (index % 6)},${index * 150} 112,${index * 150} 112,${Math.max(12, index * 150)} 120,${Math.max(12, index * 150)}`);
    if (!pathsMatchFixture) throw new Error('Indexed Timeline paths differ from coordinate fixture');
    const repeated = projectVerticalTimelineLeaders(entries, chapters, layout);
    const repeatedIdReads = reads; counting = false;
    if (first.length !== count || JSON.stringify(first) !== JSON.stringify(repeated)) throw new Error('Timeline leader fixture mismatch');
    const samplesMs = [];
    for (let iteration = 0; iteration < 5; iteration++) {
      const start = performance.now(); projectVerticalTimelineLeaders(entries, chapters, layout); samplesMs.push(performance.now() - start);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    profiles.push({ chapters: count, firstIdReads, repeatedIdReads, leaders: first.length, pathsMatchFixture,
      samplesMs, medianMs: [...samplesMs].sort((a, b) => a - b)[2] });
  }
  return { implementation: 'shared-id-index', profiles };
}

const frames = async () => {
  for (let index = 0; index < 2; index++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
};
const pointer = (type: string, x: number, pointerId = 1) => new PointerEvent(type, {
  bubbles: true, pointerId, pointerType: 'mouse', button: 0, clientX: x, clientY: 10,
});
function assertions(scope: string) {
  const checks: { id: string; passed: true }[] = [];
  return { checks, check(id: string, valid: boolean, details?: unknown) {
    if (!valid) throw new Error(`${scope}: ${id}; ${JSON.stringify(details)}`);
    checks.push({ id, passed: true });
  } };
}
function trackGestureListeners() {
  const active = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const tracked = new Set(['pointermove', 'pointerup', 'pointercancel', 'blur']);
  const add = window.addEventListener; const remove = window.removeEventListener;
  window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    if (tracked.has(type)) { const set = active.get(type) ?? new Set(); set.add(listener); active.set(type, set); }
    add.call(window, type, listener, options);
  }) as typeof window.addEventListener;
  window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
    active.get(type)?.delete(listener); remove.call(window, type, listener, options);
  }) as typeof window.removeEventListener;
  return { count: () => [...active.values()].reduce((sum, set) => sum + set.size, 0),
    restore: () => { window.addEventListener = add; window.removeEventListener = remove; } };
}

async function markerScenario(variant: 'bottom' | 'graph') {
  const { check, checks } = assertions(`timeline-marker-${variant}`);
  const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host);
  const listeners = trackGestureListeners();
  const preview = createTimelineDragPreview(); let notifications = 0;
  const off = preview.subscribe(() => { notifications++; });
  const marker: TimelineMarker = { id: 'synthetic-marker', projectId: 'synthetic-project', narrativeOrder: 1,
    label: '合成标记', driftNodeId: null, createdAt: '', updatedAt: '' };
  let cardCommits = 0; const writes: number[] = [];
  const orderToPosition = (order: number) => order * 10;
  const positionToOrder = (position: number) => position / 10;
  const prefix = variant === 'graph' ? 'graph-pin' : 'btl-pin'; const xOffset = variant === 'graph' ? 32 : 0;
  function Card() { useLayoutEffect(() => { cardCommits++; }); return createElement('div', {}, '合成章节'); }
  function Parent({ showPin = true }: { showPin?: boolean }) {
    return createElement('div', {}, Array.from({ length: 20 }, (_, key) => createElement(Card, { key })),
      createElement(TimelineMarkerLines, { preview, markers: [marker], orderToPosition, className: `${prefix}-line`, xOffset, height: 400 }),
      variant === 'bottom' && createElement('div', { className: 'synthetic-rail' },
        createElement(TimelineMarkerLines, { preview, markers: [marker], orderToPosition, className: `${prefix}-line`, onlyDragging: true })),
      showPin && createElement(TimelinePin, { marker, orderToPosition, positionToOrder, variant, pinHeight: 22,
        onChange: (patch) => { if (patch.narrativeOrder !== undefined) writes.push(patch.narrativeOrder); },
        onDelete: () => {}, onDragMove: (x) => preview.setMarker(marker.id, x) }));
  }
  const begin = () => flushSync(() => host.querySelector(`.${prefix}__label`)!.dispatchEvent(pointer('pointerdown', 10)));
  const move = (x: number, id = 1) => flushSync(() => window.dispatchEvent(pointer('pointermove', x, id)));
  const end = (type: string, x = 114, id = 1) => flushSync(() => window.dispatchEvent(pointer(type, x, id)));
  try {
    flushSync(() => root.render(createElement(Parent))); begin(); cardCommits = 0;
    for (let index = 0; index < 100; index++) move(15 + index);
    const dragCardCommits = cardCommits;
    check('pointer-burst-does-not-render-cards', cardCommits === 0 && notifications === 0);
    await frames(); const frameNotifications = notifications;
    const guide = host.querySelector<HTMLElement>(`.${prefix}-line`)!;
    check('one-frame-publishes-latest-guide', notifications === 1 && guide.style.left === `${114 + xOffset}px`
      && guide.classList.contains('is-dragging') && guide.style.height === '400px');
    check('pin-line-hides-during-drag', host.querySelector(`.${prefix}`)?.classList.contains('is-dragging') === true
      && getComputedStyle(host.querySelector(`.${prefix}__line`)!).pointerEvents === 'none');
    if (variant === 'bottom') check('rail-and-lane-guides-align', host.querySelector<HTMLElement>('.synthetic-rail .btl-pin-line')?.style.left === '114px');
    check('display-frame-does-not-render-cards', cardCommits === 0);
    end('pointerup');
    check('pointer-up-commits-continuous-coordinate', writes.length === 1 && writes[0] === 11.4 && listeners.count() === 0);
    check('pointer-up-clears-preview-immediately', Object.keys(preview.getSnapshot().markerXs).length === 0
      && !host.querySelector(`.${prefix}.is-dragging`) && !host.querySelector(`.${prefix}-line.is-dragging`));

    begin(); move(115.75); end('pointerup', 115.75);
    check('pointer-up-before-frame-keeps-exact-final-coordinate', writes.length === 2 && writes[1] === 11.575);
    await frames(); check('ended-preview-does-not-reappear', !host.querySelector(`.${prefix}-line.is-dragging`));
    begin(); move(60); await frames();
    end('pointercancel', 60, 2);
    check('foreign-pointer-cannot-cancel-active-drag', host.querySelector(`.${prefix}.is-dragging`) !== null);
    end('pointercancel', 60); end('pointerup', 60); await frames();
    check('cancel-clears-without-write', writes.length === 2 && listeners.count() === 0 && !host.querySelector(`.${prefix}-line.is-dragging`));
    begin(); move(70); flushSync(() => window.dispatchEvent(new Event('blur'))); end('pointerup', 70);
    check('window-blur-cancels-without-write', writes.length === 2 && listeners.count() === 0);
    begin(); move(80);
    flushSync(() => root.render(createElement(Parent, { showPin: false })));
    end('pointerup', 80); await frames();
    check('pin-unmount-cancels-pending-drag-and-listeners', writes.length === 2 && listeners.count() === 0
      && Object.keys(preview.getSnapshot().markerXs).length === 0 && !host.querySelector(`.${prefix}-line.is-dragging`));
    return { variant, cards: 20, moves: 100, dragCardCommits, frameNotifications, writes, checks };
  } finally { flushSync(() => root.unmount()); off(); listeners.restore(); host.remove(); }
}

async function actScenario() {
  const { check, checks } = assertions('timeline-act');
  const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host);
  const listeners = trackGestureListeners(); const preview = createTimelineDragPreview();
  const acts: BookAct[] = [{ id: 'synthetic-act', projectId: 'synthetic-project', name: '合成幕', startOrder: 1,
    color: null, driftNodeId: null, createdAt: '', updatedAt: '' }];
  let cardCommits = 0; let notifications = 0; const writes: number[] = [];
  const off = preview.subscribe(() => { notifications++; });
  function Card() { useLayoutEffect(() => { cardCommits++; }); return createElement('div', {}, '合成章节'); }
  function Parent() {
    return createElement('div', {}, Array.from({ length: 20 }, (_, key) => createElement(Card, { key })),
      createElement(TimelineActDragLine, { preview, className: 'graph-pin-line', xOffset: 32, height: 400 }),
      createElement(ActRail, { acts, chapters: [], railWidth: 0, trackWidth: 500, height: 28,
        orderToX: (order) => order * 10, minOrder: 0, maxOrder: 50,
        onRenameAct: () => {}, onDeleteAct: () => {}, onSplitAt: () => {},
        onMoveBoundary: (_id, order) => { writes.push(order); }, onBoundaryDragMove: preview.setAct }));
  }
  const begin = () => flushSync(() => host.querySelector('.actrail__label')!.dispatchEvent(pointer('pointerdown', 10)));
  const send = (type: string, x: number) => flushSync(() => window.dispatchEvent(pointer(type, x)));
  try {
    flushSync(() => root.render(createElement(Parent))); begin(); cardCommits = 0;
    for (let index = 0; index < 100; index++) send('pointermove', 15 + index);
    const dragCardCommits = cardCommits;
    check('act-pointer-burst-does-not-render-cards', cardCommits === 0 && notifications === 0);
    await frames(); const frameNotifications = notifications;
    check('act-guide-coalesces-and-keeps-host-offset', notifications === 1 && cardCommits === 0
      && host.querySelector<HTMLElement>('.graph-pin-line')?.style.left === '146px');
    send('pointerup', 114); check('act-commits-continuous-coordinate', writes.length === 1 && writes[0] === 11.4);
    begin(); send('pointermove', 115.75); send('pointerup', 115.75);
    check('act-commit-does-not-wait-for-frame', writes.length === 2 && writes[1] === 11.575);
    begin(); send('pointermove', 80); send('pointercancel', 80); send('pointerup', 80); await frames();
    check('act-cancel-clears-without-write', writes.length === 2 && listeners.count() === 0 && !host.querySelector('.graph-pin-line'));
    begin(); send('pointermove', 90); flushSync(() => root.render(null)); send('pointerup', 90); await frames();
    check('act-unmount-cancels-without-write', writes.length === 2 && listeners.count() === 0 && preview.getSnapshot().actX === null);
    return { cards: 20, moves: 100, dragCardCommits, frameNotifications, writes, checks };
  } finally { flushSync(() => root.unmount()); off(); listeners.restore(); host.remove(); }
}

export async function runTimelineScenarios() {
  const style = document.createElement('style'); style.textContent = `${bottomStyles}\n${graphStyles}`;
  document.head.appendChild(style);
  try {
    return { leaders: await leadersScenario(), marker: { implementation: 'local-pin-and-guide-preview',
      groups: [await markerScenario('bottom'), await markerScenario('graph')] }, act: await actScenario(),
      boundary: 'Actual mobile leader projection, shared TimelinePin/ActRail and guide components; synthetic sparse entries/cards and pointer events. Full Timeline UI, native touch and durable database writes are separate.' };
  } finally { style.remove(); }
}
