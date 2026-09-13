import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MemoryRouter } from 'react-router-dom';
import { WorkspaceNavigationProvider } from '../features/workspace/navigation/WorkspaceNavigationContext';
import { SuperViewNavigationProvider } from '../components/SuperViewNavigationContext';
import { SuperViewRelationUiProvider } from '../features/graph/SuperViewRelationUiContext';
import { superViewModules } from '../features/graph/deferred-graph-modules';
import { GraphCardFixture } from './graph-card-fixture';
import { createSyntheticWorkspaceProjection } from './fixture';
import { useDataStore } from '../store/data-store';
import { storyGraphUnplacedWork, graphDriftWork } from './agent-panel-counters';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const escape = () => flushSync(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
const resetWork = () => { storyGraphUnplacedWork.chips = 0; graphDriftWork.storyShell = 0; };
const work = () => ({ shell: graphDriftWork.storyShell, chips: storyGraphUnplacedWork.chips });

/** Full Story Graph and body-portaled unplaced chapters. Pointer cancellation
 * exercises the production drag controller; no completed drop or SQLite write. */
export async function runStoryGraphUnplacedScenarios() {
  await superViewModules.graph.load(); const graph = superViewModules.graph.getSnapshot();
  if (graph.status !== 'ready') throw new Error('Unplaced chapter fixture entry did not load.');
  const before = useDataStore.getState(); const stored = localStorage.getItem('graph-view-mode');
  const measurements = [];
  try {
    for (const chapters of [100, 1000, 5000]) {
      const projectId = `synthetic-unplaced-tree-${chapters}`;
      const fixture = createSyntheticWorkspaceProjection(projectId, chapters + 1, 0);
      fixture.bookNodes = fixture.bookNodes.map((node, index) => {
        if (node.kind !== 'chapter') throw new Error('Unplaced fixture requires chapters.');
        return { ...node, title: `Synthetic unplaced ${index}`, bookOrder: index, narrativeOrder: index === chapters ? 0 : null };
      });
      const at = fixture.bookNodes[0].createdAt;
      fixture.storylines = ['#112233', '#445566'].map((color, index) => ({
        id: `unplaced-storyline-${index}`, projectId, name: `Synthetic lane ${index}`, color, orderKey: index,
        contentJson: '{}', summary: '', kvJson: '[]', nodeContentTemplateJson: '{}', createdAt: at, updatedAt: at,
      }));
      fixture.primaryStorylineByNode = Object.fromEntries(fixture.bookNodes.map((node, index) => [node.id, index % 2 ? null : 'unplaced-storyline-0']));
      fixture.storylineNodeMapping = { 'unplaced-storyline-0': fixture.bookNodes.filter((_, index) => index % 2 === 0).map(node => node.id) };
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(fixture)));
      const fixtureHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      const state = useDataStore.getState(); const epoch = state.requestWorkspaceProjection(projectId, 'loading');
      state.commitWorkspaceProjection(projectId, epoch, fixture); localStorage.setItem('graph-view-mode', 'narrative');
      const navigator = { projectId, open() {}, activate() {}, showProjectHome() {}, leaveDeletedTarget() {} };
      const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host);
      const chips = () => [...document.querySelectorAll<HTMLElement>('.graph-head__unplaced-chip')];
      const popover = () => document.querySelector<HTMLElement>('.graph-head__unplaced-popover');
      try {
        resetWork();
        flushSync(() => root.render(<MemoryRouter><WorkspaceNavigationProvider navigator={navigator}>
          <SuperViewRelationUiProvider projectId={projectId}><SuperViewNavigationProvider value={{ active: 'graph', setActive() {} }}>
            <GraphCardFixture {...graph.value} />
          </SuperViewNavigationProvider></SuperViewRelationUiProvider>
        </WorkspaceNavigationProvider></MemoryRouter>));
        await pause(700); const initialWork = work();
        const tile = host.querySelector<HTMLElement>('.graph-tile')!;
        const toggle = host.querySelector<HTMLButtonElement>('.graph-head__unplaced-btn')!;
        if (!tile || !toggle || popover()) throw new Error('Unplaced chapter fixture did not mount.');
        const popupCycles = () => {
          let opened = 0;
          for (let index = 0; index < 10; index++) {
            flushSync(() => tile.click());
            if (document.querySelector('.node-card')?.textContent?.includes(`Synthetic unplaced ${chapters}`)) opened++;
            escape();
          }
          return opened;
        };
        resetWork(); const closedCycles = popupCycles(); const closedWork = work();
        resetWork(); flushSync(() => toggle.click()); await pause(30); const mountWork = work();
        if (chips().length !== chapters || mountWork.chips < chapters) throw new Error('Unplaced card mount or instrumentation missing.');
        const originalChips = chips();
        const checks = {
          closedPopoverCycles: closedCycles === 10,
          orderedChapters: originalChips.every((chip, index) => chip.title === `Synthetic unplaced ${index}` && chip.querySelector('.graph-head__unplaced-chip-num')?.textContent === `§ ${String(index).padStart(2, '0')}`),
          bodyPortal: popover()?.parentElement === document.body && getComputedStyle(popover()!).position === 'fixed',
          primaryAndUnassignedColors: originalChips[0].style.getPropertyValue('--chip-color') === '#112233' && originalChips[1].style.getPropertyValue('--chip-color') === 'hsl(var(--ink-4))',
          openPopoverCycles: false, unchangedDom: false, currentTitleAndPrimary: false, currentStorylineColor: false,
          cancelledDrag: false, escapeCloses: false, emptyState: false, reopenCurrentData: false,
        };
        resetWork(); checks.openPopoverCycles = popupCycles() === 10 && !!popover(); const openWork = work();
        checks.unchangedDom = originalChips.every(chip => chip.isConnected);
        const firstId = fixture.bookNodes[0].id;
        flushSync(() => useDataStore.setState(state => ({
          bookNodes: state.bookNodes.map(node => node.id === firstId ? { ...node, title: 'Synthetic renamed unplaced' } : node),
          primaryStorylineByNode: { ...state.primaryStorylineByNode, [firstId]: 'unplaced-storyline-1' },
          nodeStorylineMapping: { ...state.nodeStorylineMapping, [firstId]: ['unplaced-storyline-0', 'unplaced-storyline-1'] },
        })));
        checks.currentTitleAndPrimary = chips()[0] === originalChips[0] && chips()[0].title === 'Synthetic renamed unplaced'
          && chips()[0].textContent?.includes('Synthetic renamed unplaced') === true && chips()[0].style.getPropertyValue('--chip-color') === '#445566';
        flushSync(() => useDataStore.setState(state => ({ storylines: state.storylines.map(line => line.id === 'unplaced-storyline-1' ? { ...line, color: '#778899' } : line) })));
        checks.currentStorylineColor = chips()[0].style.getPropertyValue('--chip-color') === '#778899';
        const originalNodes = useDataStore.getState().bookNodes;
        const chip = chips()[0]; const rect = chip.getBoundingClientRect();
        flushSync(() => chip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 601, pointerType: 'mouse', clientX: rect.left + 10, clientY: rect.top + 10 })));
        for (let index = 0; index < 100; index++) window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 601, clientX: rect.left + 30 + index, clientY: rect.top + 10, cancelable: true }));
        await pause(30); const ghost = document.querySelector('.chapter-lane-pointer-ghost');
        const currentGhost = ghost?.textContent?.includes('Synthetic renamed unplaced') === true;
        window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 601 })); await pause(30);
        checks.cancelledDrag = currentGhost && !document.querySelector('.chapter-lane-pointer-ghost') && !popover() && toggle.getAttribute('aria-expanded') === 'false'
          && useDataStore.getState().bookNodes === originalNodes;
        flushSync(() => toggle.click()); await pause(20); escape();
        checks.escapeCloses = !popover() && toggle.getAttribute('aria-expanded') === 'false';
        flushSync(() => useDataStore.setState(state => ({ bookNodes: state.bookNodes.filter(node => node.id === fixture.bookNodes[chapters].id) })));
        flushSync(() => toggle.click()); await pause(20);
        checks.emptyState = chips().length === 0 && !!popover()?.querySelector('.graph-head__unplaced-empty')
          && host.querySelector('.graph-head__unplaced-count')?.textContent === '0';
        escape();
        flushSync(() => useDataStore.setState({ bookNodes: originalNodes }));
        flushSync(() => toggle.click()); await pause(20);
        checks.reopenCurrentData = chips().length === chapters && chips()[0].title === 'Synthetic renamed unplaced'
          && chips()[0].style.getPropertyValue('--chip-color') === '#778899'; escape();
        if (Object.values(checks).some(value => !value)) throw new Error(`Unplaced chapter behavior failed: ${JSON.stringify(checks)}`);
        measurements.push({ chapters, fixtureHash, popoverCycles: 10, pointerMoves: 100, initialWork, closedWork, mountWork, openWork, checks });
      } finally { flushSync(() => root.unmount()); host.remove(); }
    }
    return { measurements, boundary: 'Actual Story Graph and body-portaled unplaced chapter tree, current data/color and pointer cancellation. Synthetic DOM input/data; no completed drop, persistence, physical input or device latency.' };
  } finally { useDataStore.setState(before, true); if (stored === null) localStorage.removeItem('graph-view-mode'); else localStorage.setItem('graph-view-mode', stored); }
}
