// Imported only by the acceptance build transform, never by the product entry.
import { getActiveEditor, saveActiveEditor } from '../src/renderer/lib/active-editor';
import { getLiveYDoc } from '../src/renderer/lib/yjs-doc-registry';
import { useDataStore } from '../src/renderer/store/data-store';
import { useUiStore } from '../src/renderer/store/ui-store';
import { events } from '../src/renderer/lib/events';
import { getPlatformRuntime } from '../src/renderer/platform/runtime';

declare const __DRIFTING_NATIVE_ACCEPTANCE__: {
  endpoint: string; token: string;
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
let step = 'bootstrap';
Object.assign(globalThis, {
  __nativeAcceptanceRuntime(projectId: string, mounted: boolean) { lifecycle.push({ projectId, mounted }); },
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
async function waitFor<T>(predicate: () => T, description: string, timeout = 45000): Promise<NonNullable<T>> {
  const begin = performance.now();
  while (performance.now() - begin < timeout) {
    const value = predicate();
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
    useUiStore.getState().clearProjectTabs(a.id);
    location.hash = `/project/${a.id}`;
    await waitFor(() => a.nodeIds.slice(0, 20).every(id => !getLiveYDoc(`node-content:${id}`)), 'closed-tab live document cleanup');
    checks.closedTabsReleaseLiveDocuments = true;
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
  await post({ kind: 'result', status: 'passed', checks, lifecycle, firstEditorReadyMs,
    runtime: { target: runtime.target, shellMode: runtime.shellMode, appInfo: runtime.appInfo },
    userAgent: navigator.userAgent, longTasks: supportsLongTasks ? longTasks : null,
    jsHeap: null, uncaughtErrors: failures.length });
}
void run().catch(async error => {
  await post({ kind: 'result', status: 'failed', error: String(error), lifecycle, failures }).catch(() => undefined);
});
