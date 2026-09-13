import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MemoryRouter } from 'react-router-dom';
import { WorkspaceNavigationProvider } from '../features/workspace/navigation/WorkspaceNavigationContext';
import type { WorkspaceTarget } from '../features/workspace/navigation/workspace-target';
import { SuperViewNavigationProvider } from '../components/SuperViewNavigationContext';
import { SuperViewRelationUiProvider } from '../features/graph/SuperViewRelationUiContext';
import { superViewModules } from '../features/graph/deferred-graph-modules';
import { GraphCardFixture } from './graph-card-fixture';
import { createSyntheticWorkspaceProjection } from './fixture';
import { useDataStore } from '../store/data-store';
import { genericAssociationRelationType } from '../domain/entity-relation-type';
import { graphDriftWork } from './agent-panel-counters';

const resetWork = () => { for (const key of Object.keys(graphDriftWork) as (keyof typeof graphDriftWork)[]) graphDriftWork[key] = 0; };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const frames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const escape = () => flushSync(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

/** Full graph shells and special drift edges. Synthetic DOM gestures; current
 * Story Graph card reordering is visual only. No marker/relation writes. */
export async function runGraphDriftCardScenarios() {
  const before = useDataStore.getState(); const stored = localStorage.getItem('graph-view-mode');
  const measurements = [];
  try {
    for (const view of ['graph', 'element'] as const) {
      await superViewModules[view].load(); const graph = superViewModules[view].getSnapshot();
      if (graph.status !== 'ready') throw new Error('Drift card fixture graph entry did not load.');
      for (const drifts of [100, 1000, 5000]) {
        const projectId = `synthetic-drift-card-tree-${view}-${drifts}`;
        const fixture = createSyntheticWorkspaceProjection(projectId, 20, 1);
        const template = fixture.bookNodes[0];
        fixture.bookNodes.push(...Array.from({ length: drifts }, (_, index) => ({ ...template,
          id: `synthetic-drift-${index}`, kind: 'drift' as const, bookOrder: null, narrativeOrder: null,
          writingStatus: index % 2 ? 'resting' as const : 'drifting' as const,
          title: `Synthetic drift ${index}`, summary: `Synthetic drift summary ${index}`,
        })));
        const type = genericAssociationRelationType(projectId, template.createdAt); fixture.entityRelationTypes = [type];
        const mainKind = view === 'graph' ? 'node' as const : 'element' as const;
        const mainId = view === 'graph' ? template.id : fixture.bookElements[0].id;
        fixture.entityRelations = [
          { fromKind: 'node' as const, fromId: 'synthetic-drift-0', toKind: mainKind, toId: mainId },
          { fromKind: mainKind, fromId: mainId, toKind: 'node' as const, toId: 'synthetic-drift-1' },
          { fromKind: 'node' as const, fromId: 'synthetic-drift-2', toKind: 'node' as const, toId: 'synthetic-drift-3' },
        ].map((edge, index) => ({ ...edge, id: `drift-card-edge-${index}`, projectId, relationTypeId: type.id, createdAt: template.createdAt, updatedAt: template.updatedAt }));
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(fixture)));
        const fixtureHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        const state = useDataStore.getState(); const epoch = state.requestWorkspaceProjection(projectId, 'loading');
        state.commitWorkspaceProjection(projectId, epoch, fixture); localStorage.setItem('graph-view-mode', 'narrative');
        const opened: WorkspaceTarget[] = [];
        const navigator = { projectId, open: (target: WorkspaceTarget) => { opened.push(target); }, activate() {}, showProjectHome() {}, leaveDeletedTarget() {} };
        const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host);
        try {
          flushSync(() => root.render(<MemoryRouter><WorkspaceNavigationProvider navigator={navigator}>
            <SuperViewRelationUiProvider projectId={projectId}><SuperViewNavigationProvider value={{ active: view, setActive: () => {} }}>
              <GraphCardFixture {...graph.value} />
            </SuperViewNavigationProvider></SuperViewRelationUiProvider>
          </WorkspaceNavigationProvider></MemoryRouter>));
          await pause(700);
          const toggle = host.querySelector<HTMLButtonElement>(view === 'graph' ? '.graph-head__unplaced-btn' : '.super-element-toggle')!;
          resetWork(); for (let index = 0; index < 20; index++) flushSync(() => toggle.click());
          const closedWork = { ...graphDriftWork };
          resetWork(); flushSync(() => host.querySelector<HTMLButtonElement>('.drift-panel__tab')!.click());
          await pause(700); const mountWork = { ...graphDriftWork };
          const cards = [...host.querySelectorAll<HTMLElement>('.drift-card')];
          const first = cards.find(card => card.querySelector('.drift-card__title')?.textContent === 'Synthetic drift 0')!;
          const second = cards.find(card => card.querySelector('.drift-card__title')?.textContent === 'Synthetic drift 1')!;
          if (cards.length !== drifts || !first || !second || (view === 'graph' ? mountWork.storyCards : mountWork.elementCards) < drifts) throw new Error('Drift card mount or instrumentation missing.');
          const edgeSelector = view === 'graph' ? '.graph-drift-edge' : '.drift-edge';
          const initialEdges = host.querySelectorAll(edgeSelector).length;
          // Super Element intentionally limits its relation surface to edges
          // involving elements; pure node relations belong to Story Graph.
          const expectedEdges = view === 'graph' ? 3 : 2;
          resetWork(); let popoversOpened = 0;
          for (let index = 0; index < 10; index++) {
            flushSync(() => first.click());
            if (document.querySelector('.node-card')?.textContent?.includes('Synthetic drift 0')) popoversOpened++;
            escape();
          }
          const popoverWork = { ...graphDriftWork };
          const checks = { allCardsRetained: cards.every(card => card.isConnected), popoverCycles: popoversOpened === 10,
            restingStyle: second.classList.contains('is-resting'), specialEdges: initialEdges === expectedEdges,
            dragShiftAndCancel: null as boolean | null, visualDropSettles: null as boolean | null,
            reverseAndCrossSource: null as boolean | null, sourceSlotInvalidation: null as boolean | null,
            latestPair: false, currentContextMenu: false, renamedCard: false, closeAndReopen: false };
          let hoverWork: typeof graphDriftWork | null = null;
          let dragObservation: unknown = null;
          if (view === 'graph') {
            const transfer = new DataTransfer();
            flushSync(() => first.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer })));
            await pause(0); const hoverDispatches: unknown[] = [];
            resetWork();
            for (let index = 1; index <= 20; index++) {
              const target = cards[index]; const rect = target.getBoundingClientRect();
              const hover = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rect.left + 1 });
              flushSync(() => target.dispatchEvent(hover));
              hoverDispatches.push({ connected: target.isConnected, prevented: hover.defaultPrevented });
              // React treats dragover as continuous input; allow its queued
              // update to commit before dispatching the next hover.
              await frames();
            }
            hoverWork = { ...graphDriftWork };
            dragObservation = { source: first.className, transforms: cards.slice(0, 3).map(card => card.style.transform), hoverWork, hoverDispatches };
            checks.dragShiftAndCancel = first.classList.contains('is-dragged') && cards.slice(1, 20).every(card => card.style.transform === 'translateX(-178px)') && !cards[20].style.transform;
            flushSync(() => first.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer })));
            await frames();
            checks.dragShiftAndCancel &&= cards.every(card => !card.classList.contains('is-dragged') && !card.style.transform);
            const originalNodes = useDataStore.getState().bookNodes;
            flushSync(() => first.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer })));
            const targetRect = second.getBoundingClientRect();
            flushSync(() => second.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: targetRect.right - 1 })));
            await frames();
            flushSync(() => second.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })));
            await frames();
            checks.visualDropSettles = cards.every(card => !card.classList.contains('is-dragged') && !card.style.transform)
              && useDataStore.getState().bookNodes === originalNodes;
            const source = cards[20];
            flushSync(() => source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer })));
            const hoverAt = async (target: HTMLElement) => {
              const rect = target.getBoundingClientRect();
              flushSync(() => target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rect.left + 1 })));
              await frames();
            };
            await hoverAt(cards[1]);
            checks.reverseAndCrossSource = source.classList.contains('is-dragged')
              && cards.slice(1, 20).every(card => card.style.transform === 'translateX(178px)')
              && !cards[0].style.transform && !cards[21].style.transform;
            await hoverAt(cards[25]);
            checks.reverseAndCrossSource &&= cards.slice(0, 20).every(card => !card.style.transform)
              && cards.slice(21, 25).every(card => card.style.transform === 'translateX(-178px)')
              && !cards[25].style.transform;
            flushSync(() => source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer })));
            await frames();
            checks.reverseAndCrossSource &&= cards.every(card => card.isConnected && !card.style.transform && !card.classList.contains('is-dragged'));
          }
          flushSync(() => second.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
          flushSync(() => first.click());
          const pair = document.querySelector(view === 'graph' ? '.graph-newedge__pair' : '.relation-type-create-modal');
          checks.latestPair = !!pair && pair.textContent?.includes('Synthetic drift 1') === true && pair.textContent?.includes('Synthetic drift 0') === true; escape();
          flushSync(() => useDataStore.setState({ bookNodes: fixture.bookNodes.map(node => node.id === 'synthetic-drift-0' ? { ...node, title: 'Synthetic renamed drift' } : node) }));
          checks.renamedCard = first.querySelector('.drift-card__title')?.textContent === 'Synthetic renamed drift';
          flushSync(() => first.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 })));
          const menu = document.querySelector<HTMLElement>('.context-menu-surface');
          checks.currentContextMenu = !!menu && menu.parentElement === document.body && getComputedStyle(menu).position === 'fixed' && menu.textContent?.includes('Synthetic renamed drift') === true; escape();
          if (view === 'graph') flushSync(() => first.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() })));
          flushSync(() => host.querySelector<HTMLButtonElement>('.drift-panel__close')!.click()); await pause(400);
          checks.closeAndReopen = host.querySelectorAll('.drift-card').length === 0 && host.querySelectorAll(edgeSelector).length === 0;
          flushSync(() => host.querySelector<HTMLButtonElement>('.drift-panel__tab')!.click()); await pause(700);
          checks.closeAndReopen &&= host.querySelectorAll('.drift-card').length === drifts && host.querySelectorAll(edgeSelector).length === expectedEdges
            && !host.querySelector('.drift-card.is-dragged')
            && [...host.querySelectorAll<HTMLElement>('.drift-card')].every(card => !card.style.transform)
            && useDataStore.getState().entityRelations === fixture.entityRelations;
          if (view === 'graph') {
            const mounted = [...host.querySelectorAll<HTMLElement>('.drift-card')];
            const source = mounted[20]; const target = mounted[25]; const transfer = new DataTransfer();
            flushSync(() => source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer })));
            const rect = target.getBoundingClientRect();
            flushSync(() => target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rect.left + 1 })));
            await frames();
            const nodes = useDataStore.getState().bookNodes;
            flushSync(() => useDataStore.setState({ bookNodes: nodes.filter(node => node.id !== 'synthetic-drift-0') }));
            await frames();
            checks.sourceSlotInvalidation = !mounted[0].isConnected && source.isConnected
              && host.querySelectorAll('.drift-card').length === drifts - 1
              && [...host.querySelectorAll<HTMLElement>('.drift-card')].every(card => !card.style.transform && !card.classList.contains('is-dragged'));
            flushSync(() => useDataStore.setState({ bookNodes: nodes })); await frames();
            checks.sourceSlotInvalidation &&= source.isConnected && host.querySelectorAll('.drift-card').length === drifts
              && host.querySelectorAll(edgeSelector).length === expectedEdges;
          }
          if (Object.values(checks).some(value => value === false)) throw new Error(`Drift card behavior failed: ${view}: ${JSON.stringify({ checks, dragObservation })}`);
          measurements.push({ view, drifts, fixtureHash, closedToggles: 20, popoverCycles: 10, hoverEvents: view === 'graph' ? 20 : 0,
            closedWork, mountWork, popoverWork, hoverWork, checks });
        } finally { flushSync(() => root.unmount()); host.remove(); }
      }
    }
    return { implementation: 'slot-subscriptions', measurements, boundary: 'Actual graph shells, card trees and drift edges; synthetic DOM events/navigation/data. Counts distinguish leaf content from wrapper mapping. No marker or relation persistence and no physical drag acceptance.' };
  } finally { useDataStore.setState(before, true); if (stored === null) localStorage.removeItem('graph-view-mode'); else localStorage.setItem('graph-view-mode', stored); }
}
