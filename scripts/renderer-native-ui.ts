// Imported only by the acceptance build transform, never by the product entry.
import { getActiveEditor, saveActiveEditor } from '../src/renderer/lib/active-editor';
import { getLiveYDoc } from '../src/renderer/lib/yjs-doc-registry';
import { useDataStore } from '../src/renderer/store/data-store';
import { useUiStore } from '../src/renderer/store/ui-store';
import { events } from '../src/renderer/lib/events';
import { getPlatformRuntime } from '../src/renderer/platform/runtime';
import * as Y from 'yjs';
import { createBookContentRepository } from '../src/renderer/sqlite-repo/content-repo';
import { flushOpenYjsDocument } from '../src/renderer/services/yjs-local-durability.service';
import { useSettingsStore } from '../src/renderer/store/settings-store';

declare const __DRIFTING_NATIVE_ACCEPTANCE__: {
  endpoint: string; token: string;
  editorSessions: boolean;
  typewriter: boolean;
  outline: boolean;
  projects: Array<{ id: string; nodeIds: string[] }>;
};
const config = __DRIFTING_NATIVE_ACCEPTANCE__;
const marker = ' NATIVE_ACCEPTANCE_SAVED';
const started = performance.now();
const phase = localStorage.getItem('native-acceptance-phase') === 'restart' ? 'restart' : 'composition';
const lifecycle: Array<{ projectId: string; mounted: boolean }> = [];
const failures: string[] = [];
const longTasks: number[] = [];
const checks: Record<string, boolean> = {};
const sessionEvents: Array<{ instance: number; projectId: string; sourceKind: string; sourceId: string; event: string }> = [];
const sessionInstances = new WeakMap<object, number>();
let nextSessionInstance = 0;
const typewriterInstances = new WeakMap<object, number>();
const typewriterObservations: Array<{ surface: string; counts: Record<string, number> }> = [];
const outlineInstances = new WeakMap<object, number>();
const outlineObservations: Array<{ surface: string; counts: Record<string, number> }> = [];
let step = 'bootstrap';
Object.assign(globalThis, {
  __nativeAcceptanceRuntime(projectId: string, mounted: boolean) { lifecycle.push({ projectId, mounted }); },
  __nativeAcceptanceSessionEvent(session: { source: { projectId: string; sourceKind: string; sourceId: string } }, event: string) {
    let instance = sessionInstances.get(session);
    if (!instance) { instance = ++nextSessionInstance; sessionInstances.set(session, instance); }
    sessionEvents.push({ instance, ...session.source, event });
  },
  __nativeAcceptanceTypewriterEvent(owner: { editor: { view: { dom: HTMLElement } } }, event: string) {
    let index = typewriterInstances.get(owner);
    if (index === undefined) {
      index = typewriterObservations.length;
      typewriterInstances.set(owner, index);
      typewriterObservations.push({ surface: '', counts: {} });
    }
    const row = typewriterObservations[index];
    row.surface = owner.editor.view.dom.closest<HTMLElement>('[data-editor-surface]')?.dataset.editorSurface ?? row.surface;
    row.counts[event] = (row.counts[event] ?? 0) + 1;
  },
  __nativeAcceptanceOutlineEvent(owner: { root: HTMLElement }, event: string) {
    let index = outlineInstances.get(owner);
    if (index === undefined) {
      index = outlineObservations.length; outlineInstances.set(owner, index);
      outlineObservations.push({ surface: '', counts: {} });
    }
    const row = outlineObservations[index];
    row.surface = owner.root.closest<HTMLElement>('[data-editor-surface]')?.dataset.editorSurface ?? row.surface;
    row.counts[event] = (row.counts[event] ?? 0) + 1;
  },
});
window.addEventListener('error', e => failures.push(e.message.slice(0, 300)));
window.addEventListener('unhandledrejection', e => failures.push(String(e.reason).slice(0, 300)));
const supportsLongTasks = PerformanceObserver.supportedEntryTypes?.includes('longtask') ?? false;
if (supportsLongTasks) new PerformanceObserver(list => {
  for (const entry of list.getEntries()) longTasks.push(entry.duration);
}).observe({ type: 'longtask', buffered: true });

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const frames = () => Promise.race([
  new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  delay(60000).then(() => { throw new Error('Animation frames stalled: keep the acceptance window visible and foreground'); }),
]);
function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function waitFor<T>(predicate: () => T | Promise<T>, description: string, timeout = 45000): Promise<NonNullable<T>> {
  const begin = performance.now();
  while (performance.now() - begin < timeout) {
    const value = await predicate();
    if (value) return value as NonNullable<T>;
    await delay(50);
  }
  throw new Error(`Timed out: ${description}; projection=${useDataStore.getState().workspaceProjectionStatus}; alerts=${document.querySelector('[role="alert"]')?.textContent?.slice(0, 300) ?? ''}`);
}
async function post(payload: object) {
  const response = await fetch(config.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` }, body: JSON.stringify({ phase, step, ...payload }) });
  ensure(response.ok, 'Acceptance collector refused report');
}
async function progress(name: string) { step = name; await post({ kind: 'progress' }); }
function route(projectId: string, nodeId: string) { location.hash = `/project/${projectId}/editor/${nodeId}`; }
async function editorReady(nodeId?: string) {
  const surface = nodeId ? `[data-editor-surface="node:${CSS.escape(nodeId)}"]` : '[data-editor-surface]';
  const dom = await waitFor(() => [...document.querySelectorAll<HTMLElement>(`${surface}[data-editor-surface-visible="true"] .ProseMirror[contenteditable="true"]`)].find(el => el.getBoundingClientRect().height > 0 && !el.closest('[inert]')), 'visible target chapter editor');
  dom.focus();
  return waitFor(() => { const editor = getActiveEditor(); return editor?.view.dom === dom && editor; }, 'active chapter editor');
}
async function open(projectId: string, nodeId: string) {
  useUiStore.getState().openEntityTab(projectId, { entityType: 'node', id: nodeId }, { preview: false });
  route(projectId, nodeId);
  await frames();
  const editor = await editorReady(nodeId);
  await waitFor(() => getLiveYDoc(`node-content:${nodeId}`), 'live Y.Doc');
  return editor;
}
async function readyProject(projectId: string, count: number) {
  await waitFor(() => { const s = useDataStore.getState(); return s.workspaceProjectId === projectId && s.workspaceProjectionStatus === 'ready' && s.bookNodes.length === count; }, 'native project hydration');
}
async function run() {
  const [a, b] = config.projects;
  // Only the guide for this synthetic, isolated local account is suppressed.
  localStorage.setItem('drifting.alpha-guide.v4:drifting-library.db', 'seen');
  if (config.typewriter) {
    useSettingsStore.getState().setTypewriterMode(true);
    useSettingsStore.getState().setTypewriterPosition(50);
  }
  if (config.outline) useSettingsStore.getState().setOutlineRailMode('visible');
  route(a.id, a.nodeIds[0]);
  await progress('opening-native-project');
  await readyProject(a.id, 50);
  const first = await open(a.id, a.nodeIds[0]);
  const runtime = getPlatformRuntime();
  ensure(runtime.isMacDesktop && runtime.appInfo, 'This scenario requires the actual macOS Tauri platform');
  ensure(first.getText().length === 5000 + (phase === 'restart' ? marker.length : 0), 'Wrong native prose hydration length');
  const firstEditorReadyMs = performance.now() - started;
  if (phase === 'restart') {
    ensure(first.getText().endsWith(marker), 'Saved native prose did not survive process restart');
    checks.restartProse = true;
    ensure(await saveActiveEditor(), 'Restart save callback absent');
  } else {
    const doc = getLiveYDoc(`node-content:${a.nodeIds[0]}`);
    ensure(doc, 'First editor lacks its live Y.Doc');
    const before = first.getText();
    await progress('synthetic-edit-and-tabs');
    first.commands.setTextSelection(first.state.doc.content.size - 1);
    const commandStart = performance.now();
    ensure(first.commands.insertContent(marker), 'Synthetic Tiptap insertion failed');
    await frames();
    const syntheticCommandToTwoFramesMs = performance.now() - commandStart;
    ensure(first.getText() === before + marker, 'Edit did not reach actual chapter prose');
    for (const id of a.nodeIds.slice(1, 20)) await open(a.id, id);
    ensure(useUiStore.getState().tabsByProject[a.id].openTabs.length === 20, 'Expected 20 retained tabs');
    const returned = await open(a.id, a.nodeIds[0]);
    ensure(returned === first && getLiveYDoc(`node-content:${a.nodeIds[0]}`) === doc, 'Tab navigation replaced editor/session');
    ensure(first.commands.undo(), 'Undo history was lost');
    ensure(first.getText() === before, 'Undo did not restore seeded prose');
    ensure(first.commands.redo() && first.getText() === before + marker, 'Redo history was lost');
    checks.twentyTabsIdentityAndUndo = true;
    ensure(await saveActiveEditor(), 'Native production save callback missing');
    const listeningTypewriters = () => typewriterObservations.filter(row => (row.counts.resume ?? 0) > (row.counts.pause ?? 0));
    const listeningOutlines = () => outlineObservations.filter(row => (row.counts.resume ?? 0) > (row.counts.pause ?? 0));
    if (config.typewriter) {
      await waitFor(() => listeningTypewriters().length === 1, 'only one typewriter display owner among twenty tabs');
      ensure(typewriterObservations.length >= 20, 'Typewriter observations missed retained editors');
      checks.typewriterSingleVisibleOwner = true;
    }
    if (config.outline) {
      await waitFor(() => listeningOutlines().length === 1, 'one outline viewport among twenty tabs');
      ensure(outlineObservations.length >= 20, 'Outline observations missed retained editors');
      checks.outlineSingleVisibleOwner = true;
    }
    if (config.editorSessions) {
      await progress('hidden-yjs-session');
      const id = a.nodeIds[1];
      const hiddenDoc = getLiveYDoc(`node-content:${id}`);
      ensure(hiddenDoc, 'Hidden editor lost its Y.Doc');
      const outlinePublishes = (nodeId: string) => sessionEvents.filter(e => e.sourceId === nodeId && e.event === 'outline').length;
      const hiddenPublishes = outlinePublishes(id);
      const hiddenTypewriters = () => typewriterObservations.filter(row => row.surface === `node:${id}`);
      const hiddenTypewriterBefore = JSON.stringify(hiddenTypewriters());
      const hiddenOutlines = () => outlineObservations.filter(row => row.surface === `node:${id}`);
      const hiddenOutlineBefore = JSON.stringify(hiddenOutlines());
      const headingId = 'synthetic-hidden-heading';
      const headingText = 'Synthetic hidden heading';
      // An explicitly synthetic authored update to the live Y.Doc. This uses
      // the product's authored queue; it is not a remote-sync simulation.
      hiddenDoc.transact(() => {
        const heading = new Y.XmlElement<{ id: string; level: number }>('heading');
        heading.setAttribute('id', headingId);
        heading.setAttribute('level', 1);
        heading.insert(0, [new Y.XmlText(headingText)]);
        hiddenDoc.getXmlFragment('default').insert(0, [heading]);
      }, 'agent');
      await flushOpenYjsDocument(`node-content:${id}`);
      const content = createBookContentRepository();
      await waitFor(async () => (await content.findByNodeId(id))?.outlineJson.includes(headingText), 'hidden outline materialized through native SQLite');
      ensure(outlinePublishes(id) === hiddenPublishes, 'Hidden session published an outline to React');
      checks.hiddenSessionSavedWithoutOutlinePublish = true;
      if (config.typewriter) {
        ensure(hiddenTypewriters().length > 0 && JSON.stringify(hiddenTypewriters()) === hiddenTypewriterBefore, 'Hidden Yjs update performed typewriter display work');
        checks.hiddenYjsWithoutTypewriterWork = true;
      }
      if (config.outline) {
        ensure(hiddenOutlines().length > 0 && JSON.stringify(hiddenOutlines()) === hiddenOutlineBefore, 'Hidden Yjs update measured outline geometry');
        checks.hiddenYjsWithoutOutlineMeasurement = true;
      }
      const shown = await open(a.id, id);
      await waitFor(() => [...document.querySelectorAll(`[data-editor-surface="node:${id}"][data-editor-surface-visible="true"] .editor__toc-tag-text`)].some(el => el.textContent === headingText), 'prepared actual outline rail');
      ensure(getLiveYDoc(`node-content:${id}`) === hiddenDoc, 'Preparing outline recreated document');
      ensure(outlinePublishes(id) > hiddenPublishes, 'Incoming outline was not published');
      checks.hiddenOutlinePrepared = true;
      const visiblePublishes = outlinePublishes(id);
      shown.commands.setTextSelection(shown.state.doc.content.size - 1);
      shown.commands.insertContent(' transient');
      ensure(await saveActiveEditor(), 'Visible session save missing');
      ensure(outlinePublishes(id) === visiblePublishes, 'Plain prose edit republished an unchanged outline');
      ensure(shown.commands.undo(), 'Background heading destroyed local undo');
      hiddenDoc.transact(() => { hiddenDoc.getXmlFragment('default').delete(0, 1); }, 'agent');
      await flushOpenYjsDocument(`node-content:${id}`);
      ensure(await saveActiveEditor(), 'Cleanup save missing');
      await waitFor(async () => !(await content.findByNodeId(id))?.contentJson.includes(headingText), 'synthetic heading removed from native cache');
      ensure(shown.getText().length === 5000, 'Hidden-update scenario left additional prose');
      checks.plainProseKeepsOutlineStable = true;
      await open(a.id, a.nodeIds[0]);
    }
    if (config.typewriter) {
      await progress('typewriter-scroll-retention');
      await frames(); await frames();
      const viewport = first.view.dom.closest<HTMLElement>('.editor-scroll');
      ensure(viewport && viewport.scrollHeight > viewport.clientHeight + 300, 'Synthetic chapter lacks scroll range');
      viewport.scrollTop = 200;
      await frames();
      const retainedTop = viewport.scrollTop;
      const tailBefore = viewport.style.getPropertyValue('--editor-typewriter-tail-space');
      await open(a.id, a.nodeIds[2]);
      ensure(viewport.scrollTop === retainedTop && viewport.style.getPropertyValue('--editor-typewriter-tail-space') === tailBefore, 'Hiding removed tail or clamped scroll');
      const firstRows = () => typewriterObservations.filter(row => row.surface === `node:${a.nodeIds[0]}`);
      const hiddenBefore = JSON.stringify(firstRows());
      const oldHeight = viewport.style.height; const oldFlex = viewport.style.flex;
      viewport.style.height = '420px'; viewport.style.flex = 'none';
      useSettingsStore.getState().setTypewriterPosition(25);
      await frames(); await frames();
      ensure(JSON.stringify(firstRows()) === hiddenBefore, 'Hidden resize/preference change measured typewriter geometry');
      ensure(viewport.style.getPropertyValue('--editor-typewriter-tail-space') === tailBefore, 'Hidden preference update changed retained tail');
      useUiStore.getState().openEntityTab(a.id, { entityType: 'node', id: a.nodeIds[0] }, { preview: false });
      route(a.id, a.nodeIds[0]);
      await waitFor(() => first.view.dom.closest<HTMLElement>('[data-editor-surface]')?.dataset.editorSurfaceVisible === 'true', 'return without focusing retained chapter');
      ensure(viewport.scrollTop === retainedTop, 'Preparing changed retained scroll before focus');
      ensure(viewport.style.getPropertyValue('--editor-typewriter-tail-space') === `${Math.ceil(viewport.clientHeight * 0.75 + 24)}px`, 'Incoming tail was not prepared at current size/position');
      viewport.style.height = oldHeight; viewport.style.flex = oldFlex;
      useSettingsStore.getState().setTypewriterPosition(50);
      await editorReady(a.nodeIds[0]);
      first.commands.setTextSelection(first.state.doc.content.size - 1);
      await frames(); await frames();
      const caret = first.view.coordsAtPos(first.state.selection.head);
      const target = viewport.getBoundingClientRect().top + viewport.clientHeight * 0.5;
      ensure(Math.abs((caret.top + caret.bottom) / 2 - target) < 3, 'Visible native typewriter caret is not aligned');
      ensure(!first.view.dom.hasAttribute('data-typewriter-caret-repaint'), 'Caret repaint remained suppressed');
      ensure(getLiveYDoc(`node-content:${a.nodeIds[0]}`) === doc, 'Typewriter transition replaced Y.Doc');
      checks.typewriterScrollAndPreparation = true;
    }
    if (config.outline) {
      await progress('outline-navigation-and-preparation');
      const headings = Array.from({ length: 60 }, (_, index) => {
        const heading = new Y.XmlElement<{ id: string; level: number }>('heading');
        heading.setAttribute('id', `synthetic-outline-${index}`); heading.setAttribute('level', 1);
        heading.insert(0, [new Y.XmlText(`Synthetic outline ${index}`)]); return heading;
      });
      doc.transact(() => doc.getXmlFragment('default').insert(0, headings), 'agent');
      await flushOpenYjsDocument(`node-content:${a.nodeIds[0]}`);
      const viewport = first.view.dom.closest<HTMLElement>('.editor-scroll');
      const surface = first.view.dom.closest<HTMLElement>('[data-editor-surface]');
      ensure(viewport && surface, 'Outline viewport missing');
      const rail = await waitFor(() => surface.querySelector<HTMLElement>('.editor__toc-rail[data-density="windowed"]'), 'actual dense outline rail');
      const omission = await waitFor(() => rail.querySelector<HTMLButtonElement>('.editor__toc-omission'), 'actual omission handle');
      omission.focus();
      const reveal = await waitFor(() => document.querySelector<HTMLButtonElement>('body > .editor__toc-omission-reveal button'), 'portaled omission entries');
      const index = Number(reveal.textContent?.replace('Synthetic outline ', ''));
      ensure(Number.isInteger(index), 'Unexpected omission entry'); reveal.click();
      const target = first.view.dom.querySelector<HTMLElement>(`[data-block-id="synthetic-outline-${index}"]`);
      ensure(target, 'Canonical target missing');
      await waitFor(() => Math.abs(target.getBoundingClientRect().top - viewport.getBoundingClientRect().top) < 4, 'canonical omission jump');
      const visibleLabel = await waitFor(() => [...rail.querySelectorAll<HTMLButtonElement>('.editor__toc-tag')].find(button => {
        const id = Number(button.title.replace('Synthetic outline ', ''));
        const anchor = first.view.dom.querySelector<HTMLElement>(`[data-block-id="synthetic-outline-${id}"]`);
        if (!anchor) return false;
        const rect = anchor.getBoundingClientRect(); const rootRect = viewport.getBoundingClientRect();
        return rect.top >= rootRect.top && rect.bottom < rootRect.bottom;
      }), 'visible outline label');
      const pinnedTitle = visibleLabel.title; visibleLabel.focus(); visibleLabel.click();
      await frames();
      ensure(rail.querySelector<HTMLButtonElement>('[aria-current="location"]')?.title === pinnedTitle, 'Visible clicked heading did not retain primary location');
      const nextOmission = await waitFor(() => rail.querySelector<HTMLButtonElement>('.editor__toc-omission'), 'omission after jump');
      nextOmission.focus(); await waitFor(() => document.querySelector('.editor__toc-omission-reveal'), 'second omission reveal');
      await open(a.id, a.nodeIds[2]);
      ensure(!document.querySelector('.editor__toc-omission-reveal'), 'Hidden rail left a body portal visible');
      const ownRows = () => outlineObservations.filter(row => row.surface === `node:${a.nodeIds[0]}`);
      const hidden = JSON.stringify(ownRows());
      const previousHeight = viewport.style.height; const previousFlex = viewport.style.flex;
      viewport.style.height = '420px'; viewport.style.flex = 'none';
      doc.transact(() => {
        const text = headings[0].get(0) as Y.XmlText;
        text.insert(text.length, ' updated');
      }, 'agent');
      await flushOpenYjsDocument(`node-content:${a.nodeIds[0]}`);
      viewport.dispatchEvent(new Event('scroll')); window.dispatchEvent(new Event('resize'));
      await frames(); await frames();
      ensure(JSON.stringify(ownRows()) === hidden, 'Hidden outline performed geometry or scheduled frames');
      await open(a.id, a.nodeIds[0]);
      ensure(!document.querySelector('.editor__toc-omission-reveal'), 'Returning reopened a stale omission reveal');
      await waitFor(() => (first.view.dom.querySelector('[data-block-id="synthetic-outline-0"]')?.textContent ?? '').endsWith(' updated'), 'returned authoritative heading');
      ensure(JSON.stringify(ownRows()) !== hidden, 'Returning did not prepare outline geometry');
      await frames(); await frames();
      viewport.scrollTop = 0;
      await waitFor(() => rail.querySelector('[title="Synthetic outline 0 updated"]'), 'updated actual outline label after return');
      viewport.style.height = previousHeight; viewport.style.flex = previousFlex;
      doc.transact(() => doc.getXmlFragment('default').delete(0, 60), 'agent');
      await flushOpenYjsDocument(`node-content:${a.nodeIds[0]}`);
      ensure(await saveActiveEditor(), 'Outline fixture cleanup save missing');
      await waitFor(() => !rail.querySelector('.editor__toc-tag'), 'outline fixture removed');
      ensure(first.getText() === before + marker, 'Outline fixture changed original prose');
      checks.outlineNavigationAndHiddenPreparation = true;
    }
    await progress('graph-and-settings');
    const lifecycleBefore = JSON.stringify(lifecycle);
    useUiStore.getState().setActiveSuperView('graph');
    await waitFor(() => document.querySelector('.graph-overlay'), 'actual lazy story graph');
    useUiStore.getState().setActiveSuperView('none');
    await waitFor(() => !document.querySelector('.graph-overlay'), 'graph close');
    events.emit('settings:open', { railId: 'appearance' });
    const back = await waitFor(() => document.querySelector<HTMLButtonElement>('.set-head__back'), 'actual settings overlay');
    await waitFor(() => document.querySelector('.set-overlay #appearance'), 'actual deferred settings panels');
    back.click();
    await waitFor(() => !document.querySelector('.set-overlay'), 'settings close');
    ensure(await editorReady() === first && first.getText().endsWith(marker), 'Overlay navigation replaced the chapter editor');
    ensure(JSON.stringify(lifecycle) === lifecycleBefore, 'Overlay navigation restarted ProjectRuntimeProvider');
    checks.overlaysPreserveRuntimeAndEditor = true;
    await progress('split-and-cleanup');
    useUiStore.getState().splitActiveWith(a.id, { entityType: 'node', id: a.nodeIds[1] }, 'right');
    route(a.id, a.nodeIds[1]);
    await waitFor(() => document.querySelectorAll('[data-editor-surface-visible="true"] .ProseMirror[contenteditable="true"]').length === 2, 'two actual split editors');
    ensure(getLiveYDoc(`node-content:${a.nodeIds[0]}`) === doc, 'Split replaced the shared document');
    checks.splitDocumentIdentity = true;
    if (config.typewriter) {
      await waitFor(() => listeningTypewriters().length === 2, 'both visible split typewriter owners');
      const viewports = [...document.querySelectorAll<HTMLElement>('[data-editor-surface-visible="true"] .editor-scroll')];
      ensure(viewports.length === 2 && viewports.every(el => el.dataset.typewriterScroll === 'on' && parseFloat(el.style.getPropertyValue('--editor-typewriter-tail-space')) > 24), 'Unfocused split viewport lost typewriter tail');
      checks.typewriterVisibleSplit = true;
    }
    if (config.outline) {
      await waitFor(() => listeningOutlines().length === 2, 'both visible split outline owners');
      checks.outlineVisibleSplit = true;
    }
    useUiStore.getState().clearProjectTabs(a.id);
    location.hash = `/project/${a.id}`;
    await waitFor(() => a.nodeIds.slice(0, 20).every(id => !getLiveYDoc(`node-content:${id}`)), 'closed-tab live document cleanup');
    checks.closedTabsReleaseLiveDocuments = true;
    if (config.typewriter) {
      ensure(listeningTypewriters().length === 0 && typewriterObservations.every(row => row.counts.dispose === 1), 'Closed typewriter owners leaked');
      checks.typewriterClosedOwnersReleased = true;
    }
    if (config.outline) {
      ensure(listeningOutlines().length === 0 && outlineObservations.every(row => row.counts.dispose === 1), 'Closed outline owners leaked');
      checks.outlineClosedOwnersReleased = true;
    }
    if (config.editorSessions) {
      const counts = new Map<number, number>();
      for (const e of sessionEvents.filter(e => e.projectId === a.id && e.sourceKind === 'node' && a.nodeIds.slice(0, 20).includes(e.sourceId))) {
        if (e.event === 'attach') counts.set(e.instance, (counts.get(e.instance) ?? 0) + 1);
        if (e.event === 'detach') counts.set(e.instance, (counts.get(e.instance) ?? 0) - 1);
      }
      ensure(counts.size >= 20 && [...counts.values()].every(count => count === 0), 'Closed editor session bindings leaked');
      checks.closedSessionBindingsReleased = true;
    }
    await progress('project-switch');
    route(b.id, b.nodeIds[0]);
    await readyProject(b.id, 3);
    const second = await open(b.id, b.nodeIds[0]);
    ensure(second.getText().length === 5000, 'Second project prose incorrect');
    ensure(useDataStore.getState().bookElements.length === 3 && useDataStore.getState().entityRelations.length === 0, 'Mixed project projection');
    ensure(a.nodeIds.slice(0, 20).every(id => !getLiveYDoc(`node-content:${id}`)), 'Old project live docs remained');
    route(a.id, a.nodeIds[0]);
    await readyProject(a.id, 50);
    const restored = await open(a.id, a.nodeIds[0]);
    ensure(restored.getText() === before + marker, 'Native reload did not restore committed prose');
    ensure(useDataStore.getState().bookElements.length === 100 && useDataStore.getState().entityRelations.length === 500, 'Restored project projection incorrect');
    ensure(!getLiveYDoc(`node-content:${b.nodeIds[0]}`), 'Second project doc leaked');
    checks.projectSwitchAndSqliteRestore = true;
    ensure(await saveActiveEditor(), 'Restored editor save callback missing');
    localStorage.setItem('native-acceptance-phase', 'restart');
    await post({ kind: 'observation', syntheticCommandToTwoFramesMs });
  }
  ensure(failures.length === 0, `Uncaught renderer errors: ${failures.join('; ')}`);
  await post({ kind: 'result', status: 'passed', checks, lifecycle, sessionEvents, typewriterObservations, outlineObservations, firstEditorReadyMs,
    runtime: { target: runtime.target, shellMode: runtime.shellMode, appInfo: runtime.appInfo },
    userAgent: navigator.userAgent, longTasks: supportsLongTasks ? longTasks : null,
    jsHeap: null, uncaughtErrors: failures.length });
}
void run().catch(async error => {
  await post({ kind: 'result', status: 'failed', error: String(error), lifecycle, failures }).catch(() => undefined);
});
