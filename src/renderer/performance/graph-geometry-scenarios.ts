import { createElement, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { SuperElementDriftEdges } from '../features/graph/SuperElementDriftEdges';
import { measureGraphEdges, type GraphDomEdge } from '../features/graph/graph-edge-geometry';

export function createDomGraphFixture(edgeCount: number, endpointCount: number) {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;';
  document.body.appendChild(host);
  let reads = 0;
  const endpoints = new Map<string, HTMLDivElement>();
  for (let index = 0; index < endpointCount; index++) {
    const element = document.createElement('div');
    element.style.cssText = `position:absolute;left:${index % 20 * 50}px;top:${Math.floor(index / 20) * 40}px;width:40px;height:30px;`;
    const nativeRead = element.getBoundingClientRect.bind(element);
    element.getBoundingClientRect = () => { reads++; return nativeRead(); };
    host.appendChild(element); endpoints.set(String(index), element);
  }
  const half = endpointCount / 2;
  const edges: GraphDomEdge[] = Array.from({ length: edgeCount }, (_, index) => ({
    id: `synthetic-edge-${index}`, fromKind: 'node', fromId: String(index % half),
    toKind: 'element', toId: String(half + index * 7 % half), relationTypeId: 'synthetic-type',
    directed: index % 2 === 0, color: '#56789a',
  }));
  return { host, edges, endpoints, resolve: (_kind: string, id: string) => endpoints.get(id),
    reads: () => reads, reset: () => { reads = 0; } };
}

export async function runGraphGeometryScenarios() {
  const profiles = [];
  for (const [edges, endpoints] of [[100, 20], [1_000, 100], [5_000, 500]]) {
    const fixture = createDomGraphFixture(edges, endpoints);
    try {
      const output = measureGraphEdges(fixture.edges, fixture.resolve);
      profiles.push({ edges, uniqueEndpoints: endpoints, layoutReads: fixture.reads(), projectedEdges: output.length });
    } finally { fixture.host.remove(); }
  }
  const fixture = createDomGraphFixture(1_000, 100);
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  const counts = { cards: 0, labelReads: 0 };
  const cards = 20; const events = 100;
  const checks: { id: string; passed: true }[] = [];
  const check = (id: string, passed: boolean) => {
    if (!passed) throw new Error(`Graph geometry acceptance failed: ${id}`);
    checks.push({ id, passed: true });
  };
  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const settledFrame = async () => { await frame(); await frame(); };
  const burst = () => { for (let index = 0; index < events; index++) window.dispatchEvent(new Event(index % 2 ? 'scroll' : 'resize')); };
  const driftCardRefs = { current: new Map([...fixture.endpoints].filter(([id]) => Number(id) < 50)) };
  const elementCardRefs = { current: new Map([...fixture.endpoints].filter(([id]) => Number(id) >= 50)) };
  const layerRef = { current: null as SVGSVGElement | null }; const panningRef = { current: false };
  const viewportRef = { current: fixture.host };
  const selections: [string, number, number][] = [];
  const selectEdge = (id: string, x: number, y: number) => { selections.push([id, x, y]); };
  // The production layer resolves one label per edge per render. Count that
  // existing seam instead of a Profiler, which production React disables.
  const resolveRelationTypeLabel = () => { counts.labelReads++; return '合成关系'; };
  const watchedEvents = new Set(['scroll', 'resize', 'super-element:pan-end']);
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const originalAdd = window.addEventListener; const originalRemove = window.removeEventListener;
  const OriginalObserver = window.ResizeObserver;
  const observers = new Set<ResizeObserver>();
  window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    if (watchedEvents.has(type)) { const set = listeners.get(type) ?? new Set(); set.add(listener); listeners.set(type, set); }
    originalAdd.call(window, type, listener, options);
  }) as typeof window.addEventListener;
  window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
    listeners.get(type)?.delete(listener); originalRemove.call(window, type, listener, options);
  }) as typeof window.removeEventListener;
  window.ResizeObserver = class extends OriginalObserver {
    observe(target: Element, options?: ResizeObserverOptions) { super.observe(target, options); observers.add(this); }
    disconnect() { super.disconnect(); observers.delete(this); }
  };
  function Card() { useLayoutEffect(() => { counts.cards++; }); return createElement('div', {}, '合成卡片'); }
  function Parent({ revision }: { revision: number }) {
    return createElement('div', {},
      Array.from({ length: cards }, (_, key) => createElement(Card, { key })),
      createElement(SuperElementDriftEdges, { edges: fixture.edges, driftCardRefs, elementCardRefs,
          layerRef, panningRef, viewportRef, layoutRevision: revision, selectedEdgeId: null,
          selectEdge, resolveRelationTypeLabel }));
  }
  try {
    flushSync(() => root.render(createElement(Parent, { revision: 0 })));
    await new Promise<void>((resolve) => window.setTimeout(resolve, 650)); await settledFrame();
    check('actual-drift-svg-renders-all-edges', host.querySelectorAll('g.drift-edge').length === 1_000);
    check('labels-and-direction-markers-preserved', host.querySelector('title')?.textContent === '合成关系'
      && host.querySelectorAll('.drift-edge__line[marker-end]').length === 500);
    const line = () => host.querySelector('.drift-edge__line')?.getAttribute('d');
    const before = line();
    counts.cards = 0; counts.labelReads = 0; fixture.reset();
    await settledFrame();
    check('entry-measurement-stops', fixture.reads() === 0);
    burst();
    check('burst-defers-layout-reads', fixture.reads() === 0 && counts.labelReads === 0);
    await settledFrame();
    const ownership = { cards, events, cardCommits: counts.cards, geometryRenderPasses: counts.labelReads / 1_000, geometryLabelReads: counts.labelReads, layoutReads: fixture.reads() };
    check('unchanged-burst-one-read-per-endpoint-no-card-commits-or-line-render', fixture.reads() === 100 && counts.cards === 0 && counts.labelReads === 0);

    fixture.reset();
    fixture.endpoints.get('0')!.style.transform = 'translateX(15px)'; burst(); await settledFrame();
    const moved = { cardCommits: counts.cards, geometryRenderPasses: counts.labelReads / 1_000, geometryLabelReads: counts.labelReads, layoutReads: fixture.reads() };
    check('moved-geometry-only-renders-line-layer', counts.cards === 0 && counts.labelReads === 1_000 && fixture.reads() === 100 && line() !== before);
    const movedPath = line();
    counts.labelReads = 0; fixture.reset(); panningRef.current = true;
    layerRef.current?.setAttribute('data-panning', '1');
    fixture.endpoints.get('0')!.style.transform = 'translateX(30px)'; burst(); await settledFrame();
    check('pan-ref-skips-measurement-and-react', fixture.reads() === 0 && counts.labelReads === 0 && layerRef.current?.hasAttribute('data-panning') === true);
    panningRef.current = false; window.dispatchEvent(new Event('super-element:pan-end'));
    check('pan-end-keeps-stale-lines-hidden', layerRef.current?.hasAttribute('data-panning') === true && line() === movedPath);
    await settledFrame();
    check('pan-end-reveals-fresh-committed-lines', fixture.reads() === 100 && line() !== movedPath && layerRef.current?.hasAttribute('data-panning') === false);
    host.querySelector('.drift-edge__hit')?.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 123, clientY: 234 }));
    check('edge-hit-target-preserves-selection-anchor', JSON.stringify(selections) === JSON.stringify([['synthetic-edge-0', 123, 234]]));

    fixture.endpoints.get('0')!.remove(); driftCardRefs.current.delete('0');
    flushSync(() => root.render(createElement(Parent, { revision: 1 }))); await settledFrame();
    check('filtered-card-removes-only-dangling-lines', host.querySelectorAll('g.drift-edge').length === 980);
    burst(); // Leave a pending frame to prove teardown cancels it.
    flushSync(() => root.render(null)); fixture.reset();
    check('unmount-releases-listeners-and-observers', [...listeners.values()].every((set) => set.size === 0) && observers.size === 0);
    burst(); await settledFrame();
    check('unmount-cancels-pending-measurements', fixture.reads() === 0);
    return { implementation: 'unique-endpoint-overlay-state', profiles, ownership, moved, checks,
      boundary: 'Actual DOM measurement, production SuperElementDriftEdges, real animation frames and synthetic sibling cards. Full graph shell/card components, native gestures and device acceptance are separate.' };
  } finally {
    flushSync(() => root.unmount());
    window.addEventListener = originalAdd; window.removeEventListener = originalRemove; window.ResizeObserver = OriginalObserver;
    host.remove(); fixture.host.remove();
  }
}
