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
import { superElementCardWork } from './agent-panel-counters';

const resetWork = () => { superElementCardWork.categories = 0; superElementCardWork.elements = 0; superElementCardWork.bands = 0; };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Actual desktop graph shell with synthetic workspace/navigation. No SQLite
 * writes or persisted relation creation; interaction counts are not latency. */
export async function runSuperElementCardScenarios() {
  await superViewModules.element.load();
  const graph = superViewModules.element.getSnapshot();
  if (graph.status !== 'ready') throw new Error('Super Element card fixture entry did not load.');
  const before = useDataStore.getState(); const measurements = [];
  try {
    for (const elements of [100, 1000, 5000]) {
      const projectId = `synthetic-card-tree-${elements}`;
      const fixture = createSyntheticWorkspaceProjection(projectId, 20, elements);
      const template = fixture.bookElementCategories[0];
      fixture.bookElementCategories = Array.from({ length: 8 }, (_, index) => ({ ...template, id: `card-category-${index}`, name: `Synthetic category ${index}` }));
      fixture.bookElements = fixture.bookElements.map((element, index) => ({ ...element, categoryId: `card-category-${index % 8}`,
        groupName: index % 3 === 0 ? 'Synthetic group' : null, summary: `Synthetic summary ${index}` }));
      fixture.storylines = [{ id: 'card-storyline', projectId, name: 'Synthetic storyline', color: '#112233', orderKey: 0,
        contentJson: '{}', summary: '', kvJson: '[]', nodeContentTemplateJson: '{}', createdAt: template.createdAt, updatedAt: template.updatedAt }];
      fixture.primaryStorylineByNode = Object.fromEntries(fixture.bookNodes.map(node => [node.id, 'card-storyline']));
      fixture.storylineNodeMapping = { 'card-storyline': fixture.bookNodes.map(node => node.id) };
      const type = genericAssociationRelationType(projectId, template.createdAt); fixture.entityRelationTypes = [type];
      fixture.entityRelations = [{ id: 'card-edge', projectId, fromKind: 'element', fromId: fixture.bookElements[0].id,
        toKind: 'element', toId: fixture.bookElements[1].id, relationTypeId: type.id, createdAt: template.createdAt, updatedAt: template.updatedAt }];
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(fixture)));
      const fixtureHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      const state = useDataStore.getState(); const epoch = state.requestWorkspaceProjection(projectId, 'loading');
      state.commitWorkspaceProjection(projectId, epoch, fixture);
      const key = `super-element-view:viewport:${projectId}`; const stored = localStorage.getItem(key); localStorage.removeItem(key);
      const opened: WorkspaceTarget[] = []; let closed = 0;
      const navigator = { projectId, open: (target: WorkspaceTarget) => { opened.push(target); }, activate() {}, showProjectHome() {}, leaveDeletedTarget() {} };
      const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host);
      try {
        flushSync(() => root.render(<MemoryRouter><WorkspaceNavigationProvider navigator={navigator}>
          <SuperViewRelationUiProvider projectId={projectId}><SuperViewNavigationProvider value={{ active: 'element', setActive: () => { closed++; } }}>
            <GraphCardFixture {...graph.value} />
          </SuperViewNavigationProvider></SuperViewRelationUiProvider>
        </WorkspaceNavigationProvider></MemoryRouter>));
        await pause(700);
        const cards = [...host.querySelectorAll<HTMLElement>('[data-super-card="element"]')];
        const nodes = [...host.querySelectorAll<HTMLElement>('[data-super-card="node"]')];
        // The desktop islands have no chapter band, so no chapter cards.
        if (cards.length !== elements || nodes.length !== 0) throw new Error('Full graph fixture did not mount every card.');
        // The toggle that reaches every card: the islands' 正文同段 lines,
        // first in the relation menu (全部).
        const relationMenu = host.querySelector<HTMLButtonElement>('.relation-kind-menu-anchor > button')!;
        flushSync(() => relationMenu.click());
        const focus = document.querySelector<HTMLButtonElement>('[data-se-lines]')!;
        resetWork(); const started = performance.now();
        for (let index = 0; index < 20; index++) flushSync(() => focus.click());
        const focusMs = performance.now() - started; const focusWork = { ...superElementCardWork };
        const focusModeReturned = focus.getAttribute('aria-pressed') === 'true';
        flushSync(() => relationMenu.click());
        const viewport = host.querySelector<HTMLElement>('.super-view-body')!;
        resetWork();
        for (let index = 0; index < 100; index++) viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 1, deltaY: 1 }));
        await pause(150); const wheelWork = { ...superElementCardWork };
        const checks = {
          allCardsRetained: cards.every(card => card.isConnected) && nodes.every(node => node.isConnected),
          focusModeReturned,
          shiftSelectsSource: false, shiftClearsSource: false, elementPairUsesLatestSource: false,
          renameUpdatesCard: false, categoryNavigation: false,
        };
        const first = host.querySelector<HTMLElement>('[data-element-id="synthetic-element-0"]')!;
        flushSync(() => first.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
        checks.shiftSelectsSource = first.style.outline.includes('dashed') || first.classList.contains('is-held');
        flushSync(() => first.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
        checks.shiftClearsSource = first.style.outline === 'none' || (first.classList.contains('sand-cell') && !first.classList.contains('is-held'));
        const target = host.querySelector<HTMLElement>(`[data-element-id="${fixture.bookElements[elements - 1].id}"]`)!;
        for (const [source, sourceName, check] of [
          [first, fixture.bookElements[0].name, 'elementPairUsesLatestSource'],
        ] as const) {
          flushSync(() => source.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
          flushSync(() => target.click());
          const dialog = document.querySelector<HTMLElement>('.relation-type-create-modal');
          checks[check] = !!dialog && dialog.textContent?.includes(sourceName) === true
            && dialog.textContent?.includes(fixture.bookElements[elements - 1].name) === true
            && dialog.closest('.modal-root')?.parentElement === document.body;
          flushSync(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
          checks[check] &&= !document.querySelector('.relation-type-create-modal');
        }
        flushSync(() => useDataStore.setState({ bookElements: fixture.bookElements.map((element, index) => index === 0 ? { ...element, name: 'Synthetic renamed card' } : element) }));
        checks.renameUpdatesCard = first.textContent?.includes('Synthetic renamed card') === true;
        // A category opens as the island's card; its 在标签页中打开 leaves for the tab.
        const category = host.querySelector<HTMLButtonElement>('button[title="Synthetic category 0"]')!;
        flushSync(() => category.click());
        const openInTab = host.querySelector<HTMLButtonElement>('.se-island [data-se-open-tab]');
        if (openInTab) flushSync(() => openInTab.click());
        checks.categoryNavigation = opened.length === 1 && opened[0].entityType === 'category' && opened[0].id === 'card-category-0' && closed === 1;
        if (Object.values(checks).some(value => !value)) throw new Error(`Full graph card behavior failed: ${JSON.stringify(checks)}`);
        measurements.push({ elements, categories: 8, chapters: 20, fixtureHash, focusToggles: 20, wheelEvents: 100, focusMs, focusWork, wheelWork, checks });
      } finally { flushSync(() => root.unmount()); host.remove(); if (stored === null) localStorage.removeItem(key); else localStorage.setItem(key, stored); }
    }
    return { measurements, boundary: 'Full DesktopSuperElementView, production card DOM and gesture handlers; synthetic workspace/navigation. Render invocation counters, not React commit duration or native input. No persisted relation writes.' };
  } finally { useDataStore.setState(before, true); }
}
