// Acceptance build only. Imports reuse product singletons; no fixture runtime,
// Agent scenario, generated text or alternative persistence path enters startup.
import { getActiveEditor } from '../src/renderer/lib/active-editor';
import { getLiveYDoc } from '../src/renderer/lib/yjs-doc-registry';
import { useDataStore } from '../src/renderer/store/data-store';
import { useUiStore } from '../src/renderer/store/ui-store';
import { getPlatformRuntime } from '../src/renderer/platform/runtime';

declare const __DRIFTING_STARTUP_CONFIG__: { endpoint: string; token: string; projectId: string; nodeIds: string[] };
const config = __DRIFTING_STARTUP_CONFIG__;
const marks: Array<{ name: string; atMs: number }> = [];
const failures: string[] = [];
const focusTransitions: Array<{ event: string; atMs: number; focused: boolean; visibility: DocumentVisibilityState; activeElement: string | null }> = [];
const focusState = () => ({ focused: document.hasFocus(), visibility: document.visibilityState, activeElement: document.activeElement?.tagName ?? null });
for (const event of ['focus', 'blur', 'visibilitychange']) {
  window.addEventListener(event, () => {
    focusTransitions.push({ event, atMs: performance.now(), ...focusState() });
    if (focusTransitions.length > 32) focusTransitions.shift();
  }, true);
}
Object.assign(globalThis, { __DRIFTING_STARTUP_MARK__: (name: string) => marks.push({ name, atMs: performance.now() }) });
window.addEventListener('error', e => failures.push(String(e.message).slice(0, 200)));
window.addEventListener('unhandledrejection', e => failures.push(String(e.reason).slice(0, 200)));
localStorage.setItem('drifting.alpha-guide.v4:drifting-library.db', 'seen');
useUiStore.setState({ tabsByProject: {}, activeSuperView: 'none' });
location.hash = '/';
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function ensure(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function waitFor<T>(predicate: () => T, name: string): Promise<NonNullable<T>> {
  const start = performance.now();
  while (performance.now() - start < 30000) { const result = predicate(); if (result) return result; await pause(5); }
  throw new Error(`Startup timed out: ${name}`);
}
const frames = () => Promise.race([
  new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  pause(5000).then(() => { throw new Error('Startup window was not drawing'); }),
]);
async function post(payload: object) {
  const response = await fetch(config.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` }, body: JSON.stringify(payload) });
  ensure(response.ok, 'Startup collector rejected report');
}
async function run() {
  const card = await waitFor(() => [...document.querySelectorAll<HTMLElement>('.pp-card')].find(el => el.querySelector('.pp-card__title')?.textContent === `Synthetic ${config.projectId}`), 'actual shelf project card');
  const button = card.querySelector<HTMLButtonElement>('.pp-card__hit');
  ensure(button && !button.disabled, 'Project card has no enabled action');
  await document.fonts.ready; await frames();
  ensure(document.hasFocus() && document.visibilityState === 'visible', 'OS launch did not foreground the application');
  const shelfReadyMs = performance.now();
  const projectRequestedMs = performance.now(); button.click();
  await waitFor(() => { const s = useDataStore.getState(); return s.workspaceProjectId === config.projectId && s.workspaceProjectionStatus === 'ready' && s.bookNodes.length === 50; }, 'actual workspace projection');
  await frames();
  const projectReadyMs = performance.now();
  const editorTrials = [];
  // The 50k case is the first chapter editor, before a small document warms it.
  for (const [index, characters] of [[1, 50000], [0, 5000]]) {
    const nodeId = config.nodeIds[index];
    ensure(!getLiveYDoc(`node-content:${nodeId}`), 'Chapter was already hydrated before its measurement');
    const requestedMs = performance.now();
    useUiStore.getState().openEntityTab(config.projectId, { entityType: 'node', id: nodeId }, { preview: false });
    location.hash = `/project/${config.projectId}/editor/${nodeId}`;
    const dom = await waitFor(() => document.querySelector<HTMLElement>(`[data-editor-surface="node:${nodeId}"][data-editor-surface-visible="true"] .ProseMirror[contenteditable="true"]`), 'actual ready chapter surface');
    dom.focus();
    const editor = await waitFor(() => { const value = getActiveEditor(); return value?.view.dom === dom && value.getText().length === characters && value; }, 'canonical hydrated editor');
    await document.fonts.ready; await frames();
    ensure(document.hasFocus() && document.visibilityState === 'visible' && document.activeElement === dom, 'Chapter did not retain native focus');
    ensure(getLiveYDoc(`node-content:${nodeId}`) && !editor.isDestroyed && editor.isEditable, 'Chapter is not editable');
    editorTrials.push({ characters, requestedMs, readyMs: performance.now(), canonicalYjs: true, focused: true });
  }
  const runtime = getPlatformRuntime();
  ensure(runtime.isMacDesktop && runtime.appInfo, 'A real macOS Tauri runtime is required');
  ensure(failures.length === 0, failures.join('; '));
  await post({ status: 'passed', timeOrigin: performance.timeOrigin, shelfReadyMs, projectRequestedMs, projectReadyMs, editorTrials, marks,
    browser: navigator.userAgent, focused: document.hasFocus(), visible: document.visibilityState === 'visible', failures });
}
void run().catch(async error => {
  const observed = { observedAtMs: performance.now(), ...focusState() };
  let nativeWindow: { focused: boolean; visible: boolean } | { error: string };
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const window = getCurrentWindow();
    const [focused, visible] = await Promise.all([window.isFocused(), window.isVisible()]);
    nativeWindow = { focused, visible };
  } catch (nativeError) { nativeWindow = { error: String(nativeError).slice(0, 200) }; }
  await post({ status: 'failed', message: String(error), marks, failures, ...observed, nativeWindow, focusTransitions });
}).catch(() => undefined);
