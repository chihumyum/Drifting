import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MemoryRouter } from 'react-router-dom';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { TopTimeline } from '../components/topBars/TopTimeline/TopTimeline';
import { WorkspaceNavigationProvider } from '../features/workspace/navigation/WorkspaceNavigationContext';
import type { WorkspaceNavigator, WorkspaceTarget } from '../features/workspace/navigation/workspace-target';
import { DesktopTabCloseContext } from '../shells/desktop/navigation/DesktopTabCloseContext';
import { useDataStore } from '../store/data-store';
import { useUiStore, tabKey, type AnyTab, type LeafTab } from '../store/ui-store';
import { createWorkspaceSharingFixture } from './workspace-fixture';

declare global { var __TOP_TAB_WORK__: { renders: number; measurements: number; scrollChecks: number; arrayVisits: number; indexRows: number; projectedLeaves: number }; }
const wait = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
const leaf = (entityType: LeafTab['entityType'], id: string): LeafTab => ({ kind: 'leaf', entityType, id, isPreview: false });
const reset = () => { globalThis.__TOP_TAB_WORK__ = { renders: 0, measurements: 0, scrollChecks: 0, arrayVisits: 0, indexRows: 0, projectedLeaves: 0 }; };
const measure = () => ({ ...globalThis.__TOP_TAB_WORK__ });

/** Actual retained top tab strip; shell navigation/close adapters and complete
 * workspace publications are synthetic. No editors or author databases open. */
export async function runTopTabPresentationScenario() {
  const savedData = useDataStore.getState(); const savedUi = useUiStore.getState(); const profiles = [];
  const translation = i18next.createInstance();
  await translation.init({ lng: 'en', resources: {
    en: { translation: { topTimeline: { untitled: { chapter: 'Untitled chapter', drift: 'Untitled drift' }, newTab: 'New tab', singletons: { allChapters: 'All chapters' } } } },
    zh: { translation: { topTimeline: { untitled: { chapter: '未命名章节', drift: '未命名灵感' }, newTab: '新建', singletons: { allChapters: '全部章节' } } } },
  } });
  for (const nodes of [100, 1000, 5000]) for (const tabCount of [1, 5, 20]) {
    const projectId = 'synthetic-tab-project'; const data = createWorkspaceSharingFixture(projectId, nodes); let generation = 'generation-1';
    const tabs = data.bookNodes.slice(-tabCount).map(node => leaf('node', node.id));
    const container = document.createElement('div'); container.style.width = '680px'; document.body.append(container); const root = createRoot(container);
    const navigated: WorkspaceTarget[] = []; const closed: string[] = [];
    const navigator: WorkspaceNavigator = { projectId, open: target => { navigated.push(target); },
      activate: target => { navigated.push(target); useUiStore.getState().setActiveTab(projectId, target); }, showProjectHome() {}, leaveDeletedTarget() {} };
    const publish = () => flushSync(() => {
      const epoch = useDataStore.getState().requestWorkspaceProjection(projectId, 'refreshing');
      useDataStore.getState().commitWorkspaceProjection(projectId, epoch, data, undefined, generation);
    });
    const setTabs = (items: AnyTab[]) => flushSync(() => useUiStore.setState({ tabsByProject: {
      [projectId]: { openTabs: items, activeTabKey: items[0] ? tabKey(items[0]) : null, lastActiveContentTabKey: null },
    } }));
    const elementFor = (key: string) => container.querySelector<HTMLElement>(`[data-tab-key="${CSS.escape(key)}"]`)!;
    const widths = () => [...container.querySelectorAll<HTMLElement>('[data-tab-key]')].map(element => element.getBoundingClientRect().width);
    const click = (element: HTMLElement) => flushSync(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const modifyNode = (id: string, title: string) => { data.bookNodes = data.bookNodes.map(node => node.id === id ? { ...node, title } : node); publish(); };
    try {
      reset(); publish(); setTabs(tabs);
      flushSync(() => root.render(<MemoryRouter initialEntries={[`/project/${projectId}`]}><I18nextProvider i18n={translation}>
        <WorkspaceNavigationProvider navigator={navigator}><DesktopTabCloseContext.Provider value={tab => { closed.push(tabKey(tab)); useUiStore.getState().closeTab(projectId, tab.kind === 'split' ? { splitId: tab.id } : tab.kind === 'create' ? { createId: tab.id } : tab); }}>
          <TopTimeline />
        </DesktopTabCloseContext.Provider></WorkspaceNavigationProvider>
      </I18nextProvider></MemoryRouter>));
      await wait(); const initialWidths = widths(); reset();
      for (let i = 0; i < 100; i++) { data.bookNodes = data.bookNodes.map((node, index) => index === nodes - 1 ? { ...node, wordCount: i + 1 } : node); publish(); }
      const metrics = measure(); const metricsKeepWidths = JSON.stringify(widths()) === JSON.stringify(initialWidths); reset();
      for (let i = 0; i < 10; i++) { data.bookElements = data.bookElements.map((element, index) => index === 0 ? { ...element, contentJson: `{"synthetic":${i}}` } : element); publish(); }
      const unrelatedBodies = measure(); reset();
      modifyNode(data.bookNodes[0].id, 'Changed outside open tabs'); const outsideRename = measure(); reset();
      data.storylines = data.storylines.map(line => line.id === 'main' ? { ...line, color: '#ab1234' } : line); publish();
      const colorChange = measure(); const colorApplied = elementFor(tabKey(tabs[0])).querySelector<HTMLElement>('span[aria-hidden]')?.style.color === 'rgb(171, 18, 52)';
      const colorsKeepWidths = JSON.stringify(widths()) === JSON.stringify(initialWidths); reset();
      modifyNode(tabs[0].id, 'Synthetic deliberately much longer title');
      const rename = measure(); const renamed = elementFor(tabKey(tabs[0])).textContent?.includes('Synthetic deliberately much longer title') === true;
      const renameWidths = widths(); reset();
      generation = 'generation-2'; publish(); const generationChange = measure(); reset();
      flushSync(() => useDataStore.getState().requestWorkspaceProjection(projectId, 'refreshing'));
      const requestOnly = measure();
      // A loaded foreign projection with colliding ids must not label this strip.
      flushSync(() => useDataStore.setState({ workspaceProjectId: 'synthetic-other', workspaceProjectionGeneration: 'foreign' }));
      const foreignHidden = !elementFor(tabKey(tabs[0])).textContent?.includes('Synthetic deliberately much longer title');
      publish(); const projectReturns = elementFor(tabKey(tabs[0])).textContent?.includes('Synthetic deliberately much longer title') === true;
      // The actual title fallback, glyph and i18n path must still update.
      modifyNode(tabs[0].id, ''); await translation.changeLanguage('en'); await wait();
      const englishFallback = elementFor(tabKey(tabs[0])).textContent?.includes('Untitled chapter') === true;
      await translation.changeLanguage('zh'); await wait();
      const chineseFallback = elementFor(tabKey(tabs[0])).textContent?.includes('未命名章节') === true;
      data.bookNodes = data.bookNodes.map(node => node.id === tabs[0].id ? { ...node, kind: 'drift', title: '', bookOrder: null, writingStatus: 'drifting' } : node); publish();
      const driftFallback = elementFor(tabKey(tabs[0])).textContent?.includes('❦未命名灵感') === true;
      await translation.changeLanguage('en'); await wait();
      container.style.width = '240px'; await wait(); const narrowWidths = widths();
      const active = elementFor(tabKey(tabs[0])); click(active);
      const navigationWorks = navigated[navigated.length - 1]?.id === tabs[0].id;
      // Full strip drag/drop uses the real handlers and UI-store ordering.
      let dragTrace: unknown; let reorderWorks: boolean | null = null; let dragWork: ReturnType<typeof measure> | null = null; reset();
      if (tabCount > 1) {
        const source = elementFor(tabKey(tabs[0])); const target = elementFor(tabKey(tabs[tabs.length - 1])); const transfer = new DataTransfer();
        flushSync(() => source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer, clientX: source.getBoundingClientRect().left + 10 })));
        await wait(0); const startOpacity = source.style.opacity; const rect = target.getBoundingClientRect();
        flushSync(() => target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rect.right - 2 })));
        await wait(0); const marker = container.querySelector<HTMLElement>('.tab-drop-indicator')?.style.cssText;
        flushSync(() => target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })));
        flushSync(() => source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer })));
        const ordered = useUiStore.getState().tabsByProject[projectId].openTabs;
        reorderWorks = tabKey(ordered[ordered.length - 1]) === tabKey(tabs[0]) && container.querySelector<HTMLElement>('.tab-drop-indicator')?.style.opacity === '0';
        dragWork = measure(); dragTrace = { startOpacity, rect: {left:rect.left,right:rect.right}, marker, ordered: ordered.map(tabKey), expected:tabKey(tabs[0]) };
      }
      const split: AnyTab = { kind: 'split', id: 'synthetic-split', left: tabs[0], right: leaf('element', data.bookElements[0].id), focused: 'left', splitRatio: 0.5 };
      setTabs([split, leaf('all-chapters', 'self')]); await wait();
      const splitText = elementFor(tabKey(split)).textContent ?? '';
      const splitLabels = splitText.includes('Untitled drift') && splitText.includes(data.bookElements[0].name);
      const singletonLabel = elementFor('all-chapters:self').textContent?.includes('All chapters') === true;
      const splitWidths = widths();
      // Create-tab state remains a UI-store draft; a data publication cannot reset it.
      flushSync(() => { useUiStore.getState().openCreateTab(projectId); useUiStore.getState().updateCreateTabDraft(projectId, { entityKind: 'element', step: 'context' }); });
      publish(); const draft = useUiStore.getState().tabsByProject[projectId].openTabs.find(tab => tab.kind === 'create');
      const createDraftPreserved = draft?.kind === 'create' && draft.draft.entityKind === 'element' && draft.draft.step === 'context';
      setTabs([tabs[0]]); click(elementFor(tabKey(tabs[0])).querySelector<HTMLButtonElement>('button')!);
      const closeWorks = closed[0] === tabKey(tabs[0]) && !container.querySelector('[data-tab-key]');
      flushSync(() => root.unmount()); reset(); data.bookNodes = [...data.bookNodes]; publish(); const unmounted = measure();
      profiles.push({ nodes, tabCount, updates: 100, initialWidths, renameWidths, narrowWidths, splitWidths,
        metrics, unrelatedBodies, outsideRename, colorChange, rename, generationChange, requestOnly, dragWork, dragTrace, unmounted,
        checks: { metricsKeepWidths, colorApplied, colorsKeepWidths, renamed, foreignHidden, projectReturns,
          englishFallback, chineseFallback, driftFallback, navigationWorks, reorderWorks, splitLabels, singletonLabel, createDraftPreserved, closeWorks } });
    } finally { flushSync(() => root.unmount()); container.remove(); useDataStore.setState(savedData, true); useUiStore.setState(savedUi, true); }
  }
  return { build: 'production-React-mounted-top-tab-strip-Chromium', profiles,
    boundary: 'Actual strip, DOM widths, drag and UI store; synthetic shell adapters and data publications. No complete editor/native/device timing claim.' };
}
