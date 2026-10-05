import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MemoryRouter } from 'react-router-dom';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { TopTimeline } from '../components/topBars/TopTimeline/TopTimeline';
import { WorkspaceNavigationProvider } from '../features/workspace/navigation/WorkspaceNavigationContext';
import type { WorkspaceNavigator } from '../features/workspace/navigation/workspace-target';
import { DesktopTabCloseContext } from '../shells/desktop/navigation/DesktopTabCloseContext';
import { useUiStore, tabKey, type AnyTab, type LeafTab } from '../store/ui-store';
import { useDataStore } from '../store/data-store';
import { createWorkspaceSharingFixture } from './workspace-fixture';

const wait = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
const leaf = (id: string): LeafTab => ({ kind: 'leaf', entityType: 'node', id, isPreview: false });

/** Real strip and UI-store, synthetic tabs/navigation. Browser event and
 * animation evidence only; does not assert physical WKWebView drag behavior. */
export async function runTabReorderScenario(manual = false) {
  const saved = useUiStore.getState();
  const savedData = useDataStore.getState();
  const projectId = 'synthetic-tab-reorder';
  const host = document.createElement('div');
  host.style.cssText = 'width:720px;margin:32px;background:hsl(var(--surface))';
  document.body.append(host);
  const root = createRoot(host);
  const checks: Record<string, boolean> = {};
  const check = (name: string, value: boolean) => {
    checks[name] = value;
    if (!value) throw new Error(`${name}: ${JSON.stringify(Array.from(host.querySelectorAll<HTMLElement>('[data-tab-key]')).map(tab => ({ key: tab.dataset.tabKey, transform: tab.style.transform, width: tab.getBoundingClientRect().width, opacity: tab.style.opacity })))}`);
  };
  const translation = i18next.createInstance();
  await translation.init({ lng: 'en', resources: { en: { translation: { topTimeline: {
    untitled: { chapter: 'Chapter' }, newTab: 'New tab', newEntity: 'Create', closeTab: 'Close',
  } } } } });
  const navigator: WorkspaceNavigator = { projectId, open() {}, activate() {}, showProjectHome() {}, leaveDeletedTarget() {} };
  const a = leaf('a'), b = leaf('b'), c = leaf('c');
  const split: AnyTab = { kind: 'split', id: 'wide', left: leaf('d'), right: leaf('e'), focused: 'left', splitRatio: 0.5 };
  const setTabs = (tabs: AnyTab[]) => flushSync(() => useUiStore.setState({ tabsByProject: {
    [projectId]: { openTabs: tabs, activeTabKey: tabKey(tabs[0]), lastActiveContentTabKey: null },
  } }));
  const order = () => useUiStore.getState().tabsByProject[projectId].openTabs.map(tabKey).join(',');
  const el = (key: string) => host.querySelector<HTMLElement>(`[data-tab-key="${key}"]`)!;
  const strip = () => host.querySelector<HTMLElement>('.top-timeline-container')!;
  let transfer = new DataTransfer();
  let writes = 0;
  let source: HTMLElement = host;
  const unsubscribe = useUiStore.subscribe((next, previous) => {
    if (next.tabsByProject[projectId]?.openTabs !== previous.tabsByProject[projectId]?.openTabs) writes++;
  });
  const event = (target: HTMLElement, type: string, x: number, y: number) => target.dispatchEvent(
    new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: x, clientY: y }),
  );
  async function start(key: string) {
    source = el(key); transfer = new DataTransfer();
    const rect = source.getBoundingClientRect(); writes = 0;
    event(source, 'dragstart', rect.left + 20, rect.top + 20); await frame();
  }
  async function move(x: number, y = strip().getBoundingClientRect().top + 20) {
    event(strip(), 'dragover', x, y); await frame();
  }
  const end = () => event(source, 'dragend', 0, 0);
  const clean = () => !strip().dataset.tabReordering && Array.from(host.querySelectorAll<HTMLElement>('[data-tab-key]')).every(tab => !tab.style.transform && !tab.style.opacity);
  try {
    const data = createWorkspaceSharingFixture(projectId, 5);
    data.bookNodes = data.bookNodes.map((node, index) => ({ ...node, id: ['a', 'b', 'c', 'd', 'e'][index], title: `Tab ${['A', 'B', 'C', 'D', 'E'][index]}` }));
    const epoch = useDataStore.getState().requestWorkspaceProjection(projectId, 'refreshing');
    useDataStore.getState().commitWorkspaceProjection(projectId, epoch, data, undefined, 'synthetic-reorder');
    setTabs([a, split, b, c]);
    flushSync(() => root.render(<MemoryRouter><I18nextProvider i18n={translation}>
      <WorkspaceNavigationProvider navigator={navigator}><DesktopTabCloseContext.Provider value={() => {}}>
        <TopTimeline />
      </DesktopTabCloseContext.Provider></WorkspaceNavigationProvider>
    </I18nextProvider></MemoryRouter>));
    await wait();
    // Opt-in local fixture for mouse acceptance; closing the page disposes it.
    if (manual) {
      unsubscribe();
      const trace = document.createElement('pre');
      trace.style.margin = '32px';
      trace.textContent = order();
      document.body.append(trace);
      for (const type of ['dragstart', 'drop', 'dragend']) document.addEventListener(type, event => {
        const drag = event as DragEvent;
        trace.textContent += `\n${type} ${drag.dataTransfer?.getData('application/x-drifting-tab')} → ${order()}`;
      });
      return { manual: true };
    }
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const initial = order();
    const firstWidth = el('node:a').getBoundingClientRect().width;
    const wideWidth = el('split:wide').getBoundingClientRect().width;
    check('unequal-width-fixture', wideWidth > firstWidth);
    await start('node:a');
    check('split-drag-payload-preserved', transfer.getData('application/x-drifting-tab') === 'node:a');
    const last = el('node:c').getBoundingClientRect();
    await move(last.right - 5);
    const shiftOf = (key: string) => new DOMMatrix(el(key).style.transform || 'none').m41;
    check('live-neighbours-move-before-drop', Math.abs(shiftOf('split:wide') + firstWidth) < 0.01 && Math.abs(shiftOf('node:c') + firstWidth) < 0.01);
    check('no-store-writes-during-preview', order() === initial && writes === 0);
    check('neighbour-animation-policy', reduced ? el('split:wide').getAnimations().length === 0 : el('split:wide').getAnimations().length > 0);
    event(strip(), 'drop', last.right - 5, last.top + 20);
    check('drop-commits-once', order() === 'split:wide,node:b,node:c,node:a' && writes === 1);
    check('landing-animation-policy', reduced ? el('node:a').getAnimations().length === 0 : el('node:a').getAnimations().length > 0);
    end(); await wait(200);
    check('drop-cleans-transforms', clean() && host.getAnimations({ subtree: true }).length === 0);
    check('active-tab-preserved', useUiStore.getState().tabsByProject[projectId].activeTabKey === 'node:a');

    await start('node:a');
    const left = strip().getBoundingClientRect();
    await move(left.left + 2);
    check('reverse-preview', Math.abs(shiftOf('split:wide') - firstWidth) < 0.01);
    end(); await wait(200);
    check('cancel-restores-order-and-styles', order() === 'split:wide,node:b,node:c,node:a' && writes === 0 && clean());

    await start('split:wide');
    const endRect = el('node:a').getBoundingClientRect();
    const enterAccepted = !event(el('node:a'), 'dragenter', endRect.right - 5, endRect.top + 20);
    await frame();
    check('fast-dragenter-accepts-and-previews', enterAccepted && el('node:b').style.transform !== '');
    // Release must use its own coordinate, even if no final dragover arrived.
    event(strip(), 'drop', endRect.right - 5, endRect.top + 20); end(); await wait(200);
    check('wide-split-can-reach-last-slot', order() === 'node:b,node:c,node:a,split:wide' && writes === 1);

    await start('node:b'); await move(endRect.right - 5);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    end(); await wait(200);
    check('escape-does-not-commit', order() === 'node:b,node:c,node:a,split:wide' && writes === 0 && clean());

    await start('node:b'); await move(left.left + 200, left.bottom + 100);
    check('leaving-strip-removes-preview', el('node:c').style.transform === '' && source.style.opacity === '0.35');
    let received = '';
    const receive = (e: DragEvent) => { received = e.dataTransfer?.getData('application/x-drifting-tab') ?? ''; };
    document.body.addEventListener('drop', receive, { once: true });
    event(document.body, 'drop', left.left + 200, left.bottom + 100); end(); await wait(200);
    check('external-drop-retains-editor-payload', received === 'node:b' && writes === 0 && clean());

    flushSync(() => useUiStore.getState().openCreateTab(projectId)); await wait();
    const create = useUiStore.getState().tabsByProject[projectId].openTabs.slice(-1)[0]!;
    const createRect = el(tabKey(create)).getBoundingClientRect();
    event(el(tabKey(create)), 'dragstart', createRect.left + 20, createRect.top + 20);
    check('create-cannot-start-drag', !strip().dataset.tabReordering);
    event(el('node:b').querySelector('button')!, 'dragstart', createRect.left, createRect.top);
    check('close-button-cannot-start-drag', !strip().dataset.tabReordering);
    await start('node:b');
    event(strip(), 'drop', Math.min(createRect.right - 5, strip().getBoundingClientRect().right - 5), createRect.top + 20); end(); await wait(200);
    check('create-stays-last', useUiStore.getState().tabsByProject[projectId].openTabs.slice(-1)[0]?.kind === 'create');

    host.style.width = '300px'; setTabs(Array.from({ length: 12 }, (_, i) => leaf(`scroll-${i}`))); await wait();
    await start('node:scroll-0');
    const narrow = strip().getBoundingClientRect();
    await move(narrow.right - 3);
    // Assert stationary-pointer progress, not how many animation frames the
    // host schedules in a fixed 300ms while other browser fixtures are busy.
    const scrollDeadline = performance.now() + 2000;
    while (strip().scrollLeft <= 70 && performance.now() < scrollDeadline) await wait(16);
    check('stationary-pointer-scrolls-overflow', strip().scrollLeft > 70 && writes === 0);
    const scrolled = strip().scrollLeft;
    await move(narrow.right - 3, narrow.bottom + 80); await wait(100);
    check('outside-pointer-stops-scroll', strip().scrollLeft === scrolled);
    end(); await wait(200);

    strip().scrollLeft = 0;
    await start('node:scroll-0'); await move(narrow.right - 3);
    setTabs([a, b]); await wait();
    const replaced = order();
    event(strip(), 'drop', narrow.right - 3, narrow.top + 20); end(); await wait();
    check('tab-change-cancels-stale-drag', order() === replaced && clean());

    await start('node:a'); await move(narrow.right - 3);
    window.dispatchEvent(new Event('blur')); await wait();
    check('blur-cleans-up', writes === 0 && clean());
    await start('node:a'); await move(narrow.right - 3);
    flushSync(() => root.unmount());
    event(document.body, 'drop', narrow.right - 3, narrow.top + 20); end(); await wait(200);
    check('unmount-disposes-drag-and-animations', !source.style.transform && !source.style.opacity && source.getAnimations().length === 0 && writes === 0);
    return { reducedMotion: reduced, checks };
  } finally {
    if (!manual) { unsubscribe(); flushSync(() => root.unmount()); host.remove(); useUiStore.setState(saved, true); useDataStore.setState(savedData, true); }
  }
}
