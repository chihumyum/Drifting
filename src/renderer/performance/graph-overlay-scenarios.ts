import { createElement, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { SuperElementViewportEdges } from '../features/graph/SuperElementViewportEdges';
import { StoryGraphDriftEdges } from '../features/graph/StoryGraphDriftEdges';
import { useSuperElementTransform } from '../features/graph/useSuperElementTransform';
import type { SuperElementWorldEdge } from '../features/graph/super-element-edge-model';
import { createDomGraphFixture } from './graph-geometry-scenarios';
import driftStyles from '../../styles/drift-panel.css?raw';
import graphStyles from '../../styles/graph-view.css?raw';
import controlStyles from '../../styles/ui-controls.css?raw';

const frames = async (count = 3) => {
  for (let index = 0; index < count; index++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
};
function assertions(scope: string) {
  const checks: { id: string; passed: true }[] = [];
  return { checks, check(id: string, valid: boolean, details?: unknown) {
    if (!valid) throw new Error(`${scope} acceptance failed: ${id}; ${JSON.stringify(details)}`);
    checks.push({ id, passed: true });
  } };
}

async function viewportScenario() {
  const { check, checks } = assertions('viewport-overlay');
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  const worldRef = { current: null as HTMLDivElement | null };
  const bandRef = { current: null as HTMLDivElement | null };
  const viewportRef = { current: null as HTMLDivElement | null };
  const layerRef = { current: null as SVGSVGElement | null };
  const panRef = { current: { x: 10, y: 100 } }; const zoomRef = { current: 2 };
  const panningRef = { current: false }; const bandStickyRef = { current: true };
  const bandHeightCellsRef = { current: 1 }; const bandTopWorldYRef = { current: 100 }; const bandWorldLeftRef = { current: 0 };
  const config = { bandSticky: true, edgesViewportOnly: false, bandHeightCells: 1, bandTopWorldY: 100, cellWidth: 96, cellHeight: 56 };
  const edges: SuperElementWorldEdge[] = [{ id: 'edge', refId: 'edge', fromKind: 'element', toKind: 'node',
    x1: 20, y1: 200, x2: 40, y2: 128, fromName: '人物', toName: '章节', color: '#123456',
    directed: false, relationTypeId: 'type', targetInsetX: 61, targetInsetY: 34 }];
  let cardCommits = 0; let labels = 0; let transform = () => {};
  const selection: string[] = [];
  const resolveRelationTypeLabel = () => { labels++; return '关系'; };
  const selectEdge = (id: string) => { selection.push(id); };
  const focusedEdgeIds = new Set(['edge']);
  function Card() { useLayoutEffect(() => { cardCommits++; }); return createElement('div', {}, '合成卡片'); }
  function Parent({ source }: { source: SuperElementWorldEdge[] }) {
    const apply = useSuperElementTransform({ worldRef, bandRef, viewportRef, panRef, zoomRef,
      bandStickyRef, bandHeightCellsRef, bandTopWorldYRef, bandWorldLeftRef, cellHeight: 56 });
    useLayoutEffect(() => { transform = apply; apply(); }, [apply]);
    return createElement('div', { ref: viewportRef, style: { position: 'fixed', left: 0, top: 0, width: 640, height: 400 } },
      createElement('div', { ref: worldRef, style: { position: 'absolute', transformOrigin: '0 0' } },
        Array.from({ length: 20 }, (_, key) => createElement(Card, { key }))),
      createElement('div', { ref: bandRef, style: { position: 'absolute', left: 0, top: 0, transformOrigin: '0 0' } },
        createElement('div', { 'data-band-node': true, style: { position: 'absolute', left: -15, top: 0, width: 110, height: 56 } })),
      createElement(SuperElementViewportEdges, { edges: source, config, panRef, zoomRef, viewportRef, layerRef,
        panningRef, revision: 0, selectedEdgeId: null, focusedEdgeIds, selectEdge, resolveRelationTypeLabel }));
  }
  const path = () => host.querySelector('path[stroke="transparent"]')?.getAttribute('d');
  const aligned = () => {
    const rect = host.querySelector('[data-band-node]')!.getBoundingClientRect();
    return path()?.endsWith(`${rect.left + rect.width / 2} ${rect.top + rect.height / 2}`) === true;
  };
  try {
    flushSync(() => root.render(createElement(Parent, { source: edges }))); await frames();
    check('sticky-node-matches-real-band-dom', aligned());
    check('focused-edge-retains-width-and-tooltip', host.querySelector('path[stroke="#123456"]')?.getAttribute('stroke-width') === '2.4'
      && host.querySelector('title')?.textContent === '人物 → 章节  ·  关系');
    cardCommits = 0; labels = 0;
    for (let index = 0; index < 100; index++) window.dispatchEvent(new Event('resize'));
    await frames();
    const unchanged = { cardCommits, lineRenders: labels };
    check('equal-viewport-output-does-not-render-cards-or-lines', cardCommits === 0 && labels === 0);
    const before = path();
    viewportRef.current!.style.height = '300px'; // ResizeObserver only: no window event or React update.
    await frames(4);
    const resized = { cardCommits, lineRenders: labels };
    check('container-resize-keeps-band-and-svg-aligned', aligned() && path() !== before && cardCommits === 0 && labels === 1,
      { aligned: aligned(), path: path(), before, resized, band: bandRef.current?.style.transform });
    labels = 0; panningRef.current = true; layerRef.current!.setAttribute('data-panning', '1');
    panRef.current = { x: 30, y: 125 }; transform(); window.dispatchEvent(new Event('resize')); await frames();
    check('pan-transforms-without-line-or-card-render', labels === 0 && cardCommits === 0);
    panningRef.current = false; window.dispatchEvent(new Event('super-element:pan-end'));
    check('viewport-pan-end-keeps-old-lines-hidden', layerRef.current!.hasAttribute('data-panning')
      && getComputedStyle(layerRef.current!).visibility === 'hidden');
    await frames();
    check('viewport-pan-end-reveals-aligned-lines', aligned() && !layerRef.current!.hasAttribute('data-panning')
      && getComputedStyle(layerRef.current!).visibility === 'visible' && cardCommits === 0);
    flushSync(() => root.render(createElement(Parent, { source: [{ ...edges[0], fromName: '新名字' }] }))); await frames();
    check('label-only-change-reaches-tooltip', host.querySelector('title')?.textContent === '新名字 → 章节  ·  关系');
    host.querySelector('path[stroke="transparent"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    check('viewport-hit-target-retains-selection', selection.join() === 'edge');
    window.dispatchEvent(new Event('resize')); flushSync(() => root.render(null)); await frames();
    check('viewport-unmount-removes-layer', layerRef.current === null);
    return { unchanged, resized, checks };
  } finally { flushSync(() => root.unmount()); host.remove(); }
}

async function storyScenario() {
  const { check, checks } = assertions('story-drift-overlay');
  const fixture = createDomGraphFixture(1_000, 100);
  const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host);
  const driftCardRefs = { current: new Map([...fixture.endpoints].filter(([id]) => Number(id) < 50)) };
  const tileRefs = { current: new Map([...fixture.endpoints].filter(([id]) => Number(id) >= 50)) };
  const viewportRef = { current: fixture.host };
  const edges = fixture.edges.map((edge) => ({ ...edge, toKind: 'node' as const }));
  let cardCommits = 0; let labels = 0; const selections: [string, number, number][] = [];
  const resolveRelationTypeLabel = () => { labels++; return '合成关系'; };
  const selectEdge = (id: string, x: number, y: number) => { selections.push([id, x, y]); };
  function Card() { useLayoutEffect(() => { cardCommits++; }); return createElement('div', {}, '合成章节卡片'); }
  function Parent({ revision }: { revision: number }) {
    return createElement('div', {}, Array.from({ length: 20 }, (_, key) => createElement(Card, { key })),
      createElement(StoryGraphDriftEdges, { edges, driftCardRefs, tileRefs, viewportRef, revision,
        selectedEdgeId: 'synthetic-edge-0', selectEdge, resolveRelationTypeLabel }));
  }
  const burst = () => { for (let i = 0; i < 100; i++) (i % 2 ? fixture.host : fixture.endpoints.get('0')!).dispatchEvent(new Event('scroll')); };
  const path = () => host.querySelector('.graph-drift-edge__line')?.getAttribute('d');
  try {
    flushSync(() => root.render(createElement(Parent, { revision: 0 })));
    await new Promise<void>((resolve) => window.setTimeout(resolve, 550)); await frames();
    check('story-svg-preserves-edge-count-style-and-arrows', host.querySelectorAll('g.graph-drift-edge').length === 1_000
      && host.querySelectorAll('.graph-drift-edge__line[marker-end]').length === 500
      && host.querySelectorAll('g.graph-drift-edge.is-selected').length === 1
      && host.querySelector('title')?.textContent === '合成关系');
    check('story-layer-is-visible-after-measurement', getComputedStyle(host.querySelector('.graph-drift-edges')!).visibility === 'visible');
    cardCommits = 0; labels = 0; fixture.reset(); await frames();
    check('story-animation-window-stops', fixture.reads() === 0);
    burst(); check('story-scroll-burst-defers-reads', fixture.reads() === 0); await frames();
    const unchanged = { cardCommits, lineRenders: labels / 1_000, layoutReads: fixture.reads() };
    check('story-scroll-burst-one-read-per-endpoint-no-render', fixture.reads() === 100 && cardCommits === 0 && labels === 0);
    const before = path(); fixture.reset(); fixture.endpoints.get('50')!.style.transform = 'translateX(25px)';
    burst(); await frames();
    const moved = { cardCommits, lineRenders: labels / 1_000, layoutReads: fixture.reads() };
    check('story-movement-only-renders-lines', fixture.reads() === 100 && cardCommits === 0 && labels === 1_000 && path() !== before);
    host.querySelector('.graph-drift-edge__hit')?.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 11, clientY: 22 }));
    check('story-hit-target-preserves-anchor', JSON.stringify(selections) === JSON.stringify([['synthetic-edge-0', 11, 22]]));
    driftCardRefs.current.delete('0');
    flushSync(() => root.render(createElement(Parent, { revision: 1 }))); await frames();
    check('story-bound-filter-removes-dangling-lines', host.querySelectorAll('g.graph-drift-edge').length === 980);
    burst(); flushSync(() => root.render(null)); fixture.reset(); burst(); await frames();
    check('story-unmount-cancels-reads', fixture.reads() === 0);
    return { unchanged, moved, checks };
  } finally { flushSync(() => root.unmount()); host.remove(); fixture.host.remove(); }
}

export async function runGraphOverlayScenarios() {
  const viewportRule = controlStyles.match(/svg\.super-viewport-edges\[data-panning='1'\]\s*\{[^}]*\}/)?.[0];
  if (!viewportRule) throw new Error('Missing production viewport visibility rule');
  const style = document.createElement('style'); style.textContent = `${driftStyles}\n${graphStyles}\n${viewportRule}`;
  document.head.appendChild(style);
  try {
    return { viewport: await viewportScenario(), story: await storyScenario(),
      boundary: 'Production viewport/Story Graph line components, visibility CSS and Super Element transform hook with synthetic cards and real DOM/ResizeObserver. Full project shell, native gestures and device acceptance remain separate.' };
  } finally { style.remove(); }
}
