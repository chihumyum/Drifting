import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MemoryRouter, useLocation } from 'react-router-dom';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { TopTimeline } from '../components/topBars/TopTimeline/TopTimeline';
import { WorkspaceNavigationProvider } from '../features/workspace/navigation/WorkspaceNavigationContext';
import { DesktopTabCloseContext } from '../shells/desktop/navigation/DesktopTabCloseContext';
import { useDesktopWorkspaceNavigator } from '../shells/desktop/navigation/useDesktopWorkspaceNavigator';
import { useUiStore, tabKey, type SplitTab } from '../store/ui-store';
import { useDataStore } from '../store/data-store';
import { createWorkspaceSharingFixture } from './workspace-fixture';

const projectId = 'synthetic-split-preview';
const state = () => useUiStore.getState();
const project = () => state().tabsByProject[projectId];
const split = () => project().openTabs.find((tab): tab is SplitTab => tab.kind === 'split')!;
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

// This acceptance module is built once and owns its React root; it is not an HMR boundary.
// eslint-disable-next-line react-refresh/only-export-components
function Harness() {
  const { navigator } = useDesktopWorkspaceNavigator(projectId);
  const location = useLocation();
  return <WorkspaceNavigationProvider navigator={navigator}>
    <DesktopTabCloseContext.Provider value={() => {}}>
      <TopTimeline />
      {['a', 'b', 'c', 'd', 'e'].map(id => <button key={id} data-open={id}
        onClick={() => navigator.open({ entityType: 'node', id })}>Open {id}</button>)}
      <output>{location.pathname}</output>
    </DesktopTabCloseContext.Provider>
  </WorkspaceNavigationProvider>;
}

/** Real tab strip and desktop navigation; synthetic entities and click events.
 * Does not mount prose editors or assert native input / IME acceptance. */
export async function runSplitTabPreviewScenario() {
  const savedUi = state();
  const savedData = useDataStore.getState();
  const host = document.createElement('div');
  host.style.cssText = 'width:800px;margin:32px';
  document.body.append(host);
  const root = createRoot(host);
  const checks: Record<string, boolean> = {};
  const check = (name: string, passed: boolean) => {
    checks[name] = passed;
    if (!passed) throw new Error(`${name}: ${JSON.stringify(project())}`);
  };
  const translation = i18next.createInstance();
  await translation.init({ lng: 'en', resources: { en: { translation: { topTimeline: {
    untitled: { chapter: 'Chapter' }, newTab: 'New tab', newEntity: 'Create', closeTab: 'Close',
  } } } } });
  const subLabel = (label: string) => Array.from(host.querySelectorAll('.app-tab--split span'))
    .find(span => span.textContent === label)!.parentElement!;
  const click = async (element: HTMLElement, twice = false) => {
    flushSync(() => {
      element.click();
      if (twice) {
        element.click();
        element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
      }
    });
    await frame();
  };
  const open = (id: string) => click(host.querySelector<HTMLElement>(`[data-open="${id}"]`)!);
  try {
    const fixture = createWorkspaceSharingFixture(projectId, 5);
    fixture.bookNodes = fixture.bookNodes.map((node, i) => ({ ...node,
      id: ['a', 'b', 'c', 'd', 'e'][i], title: `Tab ${['A', 'B', 'C', 'D', 'E'][i]}` }));
    const epoch = useDataStore.getState().requestWorkspaceProjection(projectId, 'refreshing');
    useDataStore.getState().commitWorkspaceProjection(projectId, epoch, fixture, undefined, 'synthetic-preview');
    state().clearProjectTabs(projectId);
    state().openEntityTab(projectId, { entityType: 'node', id: 'a' });
    state().splitActiveWith(projectId, { entityType: 'node', id: 'b' }, 'right');
    const splitId = split().id;
    flushSync(() => root.render(<MemoryRouter initialEntries={[`/project/${projectId}/editor/b`]}>
      <I18nextProvider i18n={translation}><Harness /></I18nextProvider>
    </MemoryRouter>));
    await frame();
    check('both-previews-are-italic', getComputedStyle(subLabel('Tab A')).fontStyle === 'italic'
      && getComputedStyle(subLabel('Tab B')).fontStyle === 'italic');
    await click(subLabel('Tab A'), true);
    check('left-double-click-pins-only-left', !split().left.isPreview && split().right.isPreview
      && getComputedStyle(subLabel('Tab A')).fontStyle === 'normal');
    await open('c');
    check('dedicated-focus-preserves-split', split().left.id === 'a' && split().right.id === 'b'
      && project().activeTabKey === 'node:c' && project().openTabs.length === 2);
    check('new-tab-route-follows-target', host.querySelector('output')!.textContent!.endsWith('/editor/c'));
    await click(subLabel('Tab B'));
    await open('d');
    check('focused-right-preview-replaced', project().activeTabKey === `split:${splitId}`
      && split().left.id === 'a' && split().right.id === 'd' && split().right.isPreview);
    check('replacement-keeps-italic-and-route', getComputedStyle(subLabel('Tab D')).fontStyle === 'italic'
      && host.querySelector('output')!.textContent!.endsWith('/editor/d'));
    await click(subLabel('Tab D'), true);
    check('right-double-click-pins-right', !split().right.isPreview
      && getComputedStyle(subLabel('Tab D')).fontStyle === 'normal');
    await open('e');
    check('pinned-split-reuses-ordinary-preview', project().openTabs.map(tabKey).join(',') === `split:${splitId},node:e`
      && split().left.id === 'a' && split().right.id === 'd');
    await open('a');
    check('existing-left-activates-without-duplicate', split().focused === 'left'
      && project().activeTabKey === `split:${splitId}` && project().openTabs.length === 2);
    // A new split with a left preview exercises the symmetric replacement.
    flushSync(() => {
      state().clearProjectTabs(projectId);
      state().openEntityTab(projectId, { entityType: 'node', id: 'a' }, { preview: false });
      state().splitActiveWith(projectId, { entityType: 'node', id: 'b' }, 'left');
    });
    await open('c');
    check('focused-left-preview-replaced', split().left.id === 'c' && split().left.isPreview
      && split().right.id === 'a' && !split().right.isPreview && project().openTabs.length === 1);
    flushSync(() => state().promoteTab(projectId));
    await open('d');
    check('current-tab-promotion-protects-left', split().left.id === 'c' && !split().left.isPreview
      && project().activeTabKey === 'node:d');
    return checks;
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    useUiStore.setState(savedUi, true);
    useDataStore.setState(savedData, true);
  }
}
