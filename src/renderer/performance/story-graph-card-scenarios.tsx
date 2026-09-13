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
import { storyGraphCardWork } from './agent-panel-counters';

const resetWork = () => { storyGraphCardWork.lanes = 0; storyGraphCardWork.tiles = 0; storyGraphCardWork.groupingVisits = 0; };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const escape = () => flushSync(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

/** Full product lanes and pointer lifecycle, with synthetic workspace data.
 * Cancels drops and relation dialogs before persistence; no SQLite writes. */
export async function runStoryGraphCardScenarios() {
  await superViewModules.graph.load();
  const graph = superViewModules.graph.getSnapshot();
  if (graph.status !== 'ready') throw new Error('Story Graph card fixture entry did not load.');
  const before = useDataStore.getState(); const stored = localStorage.getItem('graph-view-mode');
  const measurements = [];
  try {
    for (const [chapters, storylines] of [[100, 8], [1000, 24], [5000, 50]]) {
      const projectId = `synthetic-story-card-tree-${chapters}`;
      const fixture = createSyntheticWorkspaceProjection(projectId, chapters + 1, 0);
      const at = fixture.bookNodes[0].createdAt;
      fixture.bookNodes = fixture.bookNodes.map((node, index) => {
        if (node.kind !== 'chapter') throw new Error('Story Graph fixture requires chapter rows.');
        return { ...node, title: `Synthetic chapter ${index}`, bookOrder: index * 5, narrativeOrder: index === chapters ? null : index * 5 };
      });
      fixture.storylines = Array.from({ length: storylines }, (_, index) => ({
        id: `card-storyline-${index}`, projectId, name: `Synthetic storyline ${index}`, color: '#112233', orderKey: index,
        contentJson: '{}', summary: '', kvJson: '[]', nodeContentTemplateJson: '{}', createdAt: at, updatedAt: at,
      }));
      fixture.storylineNodeMapping = Object.fromEntries(fixture.storylines.map((storyline, index) => [storyline.id,
        fixture.bookNodes.filter((_, nodeIndex) => nodeIndex % storylines === index).map(node => node.id)]));
      fixture.primaryStorylineByNode = Object.fromEntries(fixture.bookNodes.map((node, index) => [node.id, `card-storyline-${index % storylines}`]));
      const type = genericAssociationRelationType(projectId, at); fixture.entityRelationTypes = [type];
      fixture.entityRelations = [{ id: 'story-card-edge', projectId, fromKind: 'node', fromId: fixture.bookNodes[0].id,
        toKind: 'node', toId: fixture.bookNodes[1].id, relationTypeId: type.id, createdAt: at, updatedAt: at }];
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(fixture)));
      const fixtureHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      const state = useDataStore.getState(); const epoch = state.requestWorkspaceProjection(projectId, 'loading');
      state.commitWorkspaceProjection(projectId, epoch, fixture); localStorage.setItem('graph-view-mode', 'narrative');
      const opened: WorkspaceTarget[] = []; let closed = 0;
      const navigator = { projectId, open: (target: WorkspaceTarget) => { opened.push(target); }, activate() {}, showProjectHome() {}, leaveDeletedTarget() {} };
      const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host);
      try {
        resetWork();
        flushSync(() => root.render(<MemoryRouter><WorkspaceNavigationProvider navigator={navigator}>
          <SuperViewRelationUiProvider projectId={projectId}><SuperViewNavigationProvider value={{ active: 'graph', setActive: () => { closed++; } }}>
            <GraphCardFixture {...graph.value} />
          </SuperViewNavigationProvider></SuperViewRelationUiProvider>
        </WorkspaceNavigationProvider></MemoryRouter>));
        await pause(700); const mountWork = { ...storyGraphCardWork };
        if (mountWork.tiles < chapters || mountWork.lanes < storylines + 1 || mountWork.groupingVisits < chapters) throw new Error('Story Graph card instrumentation did not observe initial work.');
        const tiles = [...host.querySelectorAll<HTMLElement>('.graph-tile')];
        const first = tiles.find(tile => tile.querySelector('.graph-tile__title')?.textContent === 'Synthetic chapter 0')!;
        const second = tiles.find(tile => tile.querySelector('.graph-tile__title')?.textContent === 'Synthetic chapter 1')!;
        if (tiles.length !== chapters || !first || !second) throw new Error('Story Graph card fixture did not mount.');
        const drawer = host.querySelector<HTMLButtonElement>('.graph-head__unplaced-btn')!;
        resetWork();
        for (let index = 0; index < 20; index++) flushSync(() => drawer.click());
        const drawerWork = { ...storyGraphCardWork };
        let popoversOpened = 0;
        resetWork();
        for (let index = 0; index < 10; index++) {
          flushSync(() => first.click());
          if (document.querySelector('.node-card')?.textContent?.includes('Synthetic chapter 0')) popoversOpened++;
          escape();
        }
        const popoverWork = { ...storyGraphCardWork };
        resetWork(); const rect = first.getBoundingClientRect();
        flushSync(() => first.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 401, pointerType: 'mouse', clientX: rect.left + 10, clientY: rect.top + 10 })));
        for (let index = 0; index < 100; index++) window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 401, clientX: rect.left + 30 + index, clientY: rect.top + 10, cancelable: true }));
        await pause(30); const ghostVisible = !!document.querySelector('.chapter-lane-pointer-ghost');
        window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 401 })); await pause(10);
        const pointerWork = { ...storyGraphCardWork };
        const checks = {
          allCardsRetained: tiles.every(tile => tile.isConnected),
          primaryLaneMembership: tiles.every(tile => {
            const index = Number(tile.querySelector('.graph-tile__title')?.textContent?.replace('Synthetic chapter ', ''));
            return tile.closest('[data-storyline-row]')?.getAttribute('data-storyline-row') === `card-storyline-${index % storylines}`;
          }),
          drawerReturned: drawer.getAttribute('aria-expanded') === 'false',
          popoverCycles: popoversOpened === 10 && !document.querySelector('.node-card'),
          cancelledDragCleaned: ghostVisible && !document.querySelector('.chapter-lane-pointer-ghost') && first.style.visibility !== 'hidden',
          shiftSelectsSource: false, shiftClearsSource: false, latestPair: false, renamedCard: false,
          reassignedPrimaryLane: false, contextMenuUsesCurrentNode: false, doubleClickNavigation: false,
        };
        flushSync(() => first.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
        checks.shiftSelectsSource = first.classList.contains('is-link-source');
        flushSync(() => first.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
        checks.shiftClearsSource = !first.classList.contains('is-link-source');
        flushSync(() => second.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
        flushSync(() => first.click());
        const pair = [...host.querySelectorAll('.graph-newedge__pair > span')].map(span => span.textContent);
        checks.latestPair = pair.join('|') === 'Synthetic chapter 1|Synthetic chapter 0'; escape();
        checks.latestPair &&= !host.querySelector('.graph-newedge');
        flushSync(() => useDataStore.setState({ bookNodes: fixture.bookNodes.map((node, index) => index === 0 ? { ...node, title: 'Synthetic renamed chapter' } : node) }));
        checks.renamedCard = first.querySelector('.graph-tile__title')?.textContent === 'Synthetic renamed chapter';
        const targetLane = `card-storyline-${storylines - 1}`;
        const nodeId = fixture.bookNodes[0].id;
        flushSync(() => useDataStore.setState(state => ({
          nodeStorylineMapping: { ...state.nodeStorylineMapping, [nodeId]: ['card-storyline-0', targetLane] },
          primaryStorylineByNode: { ...state.primaryStorylineByNode, [nodeId]: targetLane },
        })));
        const moved = [...host.querySelectorAll<HTMLElement>('.graph-tile')].filter(tile => tile.querySelector('.graph-tile__title')?.textContent === 'Synthetic renamed chapter');
        checks.reassignedPrimaryLane = moved.length === 1 && !first.isConnected
          && moved[0].closest('[data-storyline-row]')?.getAttribute('data-storyline-row') === targetLane
          && moved[0].style.left === first.style.left && host.querySelectorAll('.graph-tile').length === chapters;
        flushSync(() => moved[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 240, clientY: 180 })));
        const menu = document.querySelector<HTMLElement>('.context-menu-surface');
        checks.contextMenuUsesCurrentNode = !!menu && menu.parentElement === document.body && getComputedStyle(menu).position === 'fixed'
          && menu.textContent?.includes('Synthetic renamed chapter') === true && menu.textContent?.includes(`Synthetic storyline ${storylines - 1}`) === true;
        escape(); checks.contextMenuUsesCurrentNode &&= !document.querySelector('.context-menu-surface');
        flushSync(() => moved[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
        checks.doubleClickNavigation = opened.length === 1 && opened[0].entityType === 'node' && opened[0].id === fixture.bookNodes[0].id && closed === 1;
        if (Object.values(checks).some(value => !value)) throw new Error(`Story Graph card behavior failed: ${JSON.stringify(checks)}`);
        measurements.push({ chapters, storylines, lanes: storylines + 1, fixtureHash, drawerToggles: 20, popoverCycles: 10, pointerMoves: 100,
          mountWork, drawerWork, popoverWork, pointerWork, checks });
      } finally { flushSync(() => root.unmount()); host.remove(); }
    }
    return { measurements, boundary: 'Full Story Graph with owned deferred entries, production lanes, popovers and pointer cancellation. Synthetic navigation/data; no completed drop or persisted relation write. Work counts, not input latency.' };
  } finally { useDataStore.setState(before, true); if (stored === null) localStorage.removeItem('graph-view-mode'); else localStorage.setItem('graph-view-mode', stored); }
}
