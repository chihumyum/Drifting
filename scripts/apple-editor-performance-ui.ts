// Acceptance-build entry, injected into the real production renderer main.tsx.
// Never instantiate a simplified Editor here: the measured ChapterEditor owns
// the production React, Tiptap, Yjs, persistence and decoration configuration.
import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { getActiveEditor } from '../src/renderer/lib/active-editor';
import { getLiveYDoc } from '../src/renderer/lib/yjs-doc-registry';
import { getPlatformRuntime } from '../src/renderer/platform/runtime';
import { flushAllYjsDocumentsLocally } from '../src/renderer/services/yjs-local-durability.service';
import { useDataStore } from '../src/renderer/store/data-store';
import { useUiStore } from '../src/renderer/store/ui-store';

export interface EditorPerformanceUiCase {
  id: string;
  nodeId: string;
  utf16Length: number;
  paragraphCount: number;
  plainTextSha256: string;
}
export interface EditorPerformanceUiConfig {
  endpoint: string;
  token: string;
  projectId: string;
  corpusSha256: string;
  cases: EditorPerformanceUiCase[];
  samplesPerCase: number;
  warmSwitchSamples: number;
  scrollSteps: number;
  editRange: { location: number; length: number };
  editText: string;
}
declare const __DRIFTING_EDITOR_PERFORMANCE_CONFIG__: EditorPerformanceUiConfig;
const config = __DRIFTING_EDITOR_PERFORMANCE_CONFIG__;
const samples: Record<string, unknown>[] = [];
const failures: string[] = [];
const baselineEditors = new Map<string, Editor>();
const baselineYDocs = new Map<string, ReturnType<typeof getLiveYDoc>>();
const now = () => performance.now();
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function visibleAndFocused() {
  ensure(document.visibilityState === 'visible' && document.hasFocus(), 'Performance window lost foreground visibility/focus');
}
async function waitFor<T>(predicate: () => T, label: string): Promise<NonNullable<T>> {
  const started = now();
  while (now() - started < 60_000) {
    const result = predicate();
    if (result) return result;
    await pause(5);
  }
  throw new Error(`Editor performance timeout: ${label}`);
}
async function frame(): Promise<number> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cancelAnimationFrame(handle); reject(new Error('Visible window did not deliver animation frame')); }, 5000);
    const handle = requestAnimationFrame(time => { clearTimeout(timeout); resolve(time); });
  });
}
async function paintOpportunity() {
  const firstFrameMs = await frame();
  const secondFrameMs = await frame();
  visibleAndFocused();
  return { firstFrameMs, secondFrameMs, callbackSpacingMs: secondFrameMs - firstFrameMs, observedAtMs: now() };
}
function plainText(editor: Editor) {
  return editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n');
}
async function hashText(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function jsHeap() {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  return memory && [memory.usedJSHeapSize, memory.totalJSHeapSize, memory.jsHeapSizeLimit].every(Number.isFinite)
    ? { status: 'observed', scope: 'browser performance.memory; not whole-app resident memory',
      usedBytes: memory.usedJSHeapSize, totalBytes: memory.totalJSHeapSize, limitBytes: memory.jsHeapSizeLimit }
    : { status: 'unavailable', reason: 'This WebView does not expose performance.memory' };
}

const longTasks: Array<{ startTime: number; duration: number; name: string }> = [];
const longTaskSupported = typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask') === true;
const recordLongTasks = (entries: PerformanceEntry[]) => {
  for (const entry of entries) longTasks.push({ startTime: entry.startTime, duration: entry.duration, name: entry.name });
};
const longTaskObserver = longTaskSupported ? new PerformanceObserver(list => recordLongTasks(list.getEntries())) : null;
longTaskObserver?.observe({ type: 'longtask', buffered: true });

async function measure(phase: string, item: EditorPerformanceUiCase, sampleIndex: number,
  operation: () => Promise<Record<string, unknown>>) {
  visibleAndFocused();
  const heapBefore = jsHeap();
  const frameTimes: number[] = [];
  let frameHandle = 0;
  let observing = true;
  const observeFrame = (time: number) => {
    if (!observing) return;
    frameTimes.push(time);
    frameHandle = requestAnimationFrame(observeFrame);
  };
  const startedAtMs = now();
  frameHandle = requestAnimationFrame(observeFrame);
  let details: Record<string, unknown>;
  try { details = await operation(); }
  finally { observing = false; cancelAnimationFrame(frameHandle); }
  const endedAtMs = now();
  visibleAndFocused();
  // Flush observer delivery after the measured interval, never include it in latency.
  await pause(0);
  if (longTaskObserver) recordLongTasks(longTaskObserver.takeRecords());
  const overlappingTasks = longTasks.filter(task => task.startTime < endedAtMs && task.startTime + task.duration > startedAtMs);
  samples.push({ phase, caseId: item.id, sampleIndex, startedAtMs, endedAtMs, durationMs: endedAtMs - startedAtMs,
    frameIntervalsMs: frameTimes.slice(1).map((time, index) => time - frameTimes[index]),
    longTasks: longTaskSupported ? { status: 'observed', entries: overlappingTasks }
      : { status: 'unavailable', reason: 'Long Tasks API is not exposed; rAF gaps are reported separately' },
    heapBefore, heapAfter: jsHeap(), details });
  return details;
}

async function activate(item: EditorPerformanceUiCase): Promise<Editor> {
  useUiStore.getState().openEntityTab(config.projectId, { entityType: 'node', id: item.nodeId }, { preview: false });
  location.hash = `/project/${config.projectId}/editor/${item.nodeId}`;
  const dom = await waitFor(() => document.querySelector<HTMLElement>(
    `[data-editor-surface="node:${CSS.escape(item.nodeId)}"][data-editor-surface-visible="true"] .ProseMirror[contenteditable="true"]`), 'actual visible chapter surface');
  dom.focus();
  const editor = await waitFor(() => {
    const active = getActiveEditor();
    return active?.view.dom === dom && !active.isDestroyed && active.isEditable ? active : null;
  }, 'active product editor');
  await waitFor(() => plainText(editor).length === item.utf16Length, 'canonical UTF-16 text length');
  const ydoc = getLiveYDoc(`node-content:${item.nodeId}`);
  const collaboration = editor.extensionManager.extensions.find(extension => extension.name === 'collaboration');
  ensure(ydoc && collaboration?.options.document === ydoc && collaboration.options.field === 'default', 'Measured editor is not using the live product Y.Doc/default fragment');
  ensure(editor.extensionManager.extensions.some(extension => extension.name === 'blockId'), 'Production BlockId plugin missing');
  await document.fonts.ready;
  return editor;
}

async function verifyCorpus(item: EditorPerformanceUiCase, editor: Editor) {
  const text = plainText(editor);
  ensure(text.length === item.utf16Length, `${item.id} UTF-16 length mismatch`);
  ensure(editor.state.doc.childCount === item.paragraphCount, `${item.id} paragraph count mismatch`);
  ensure(await hashText(text) === item.plainTextSha256, `${item.id} canonical corpus hash mismatch`);
}

function prosePosition(editor: Editor, offset: number) {
  let globalOffset = 0;
  let found: number | undefined;
  editor.state.doc.descendants((node, position) => {
    if (!node.isTextblock) return true;
    if (found === undefined && globalOffset <= offset && offset <= globalOffset + node.content.size) {
      found = position + 1 + offset - globalOffset;
    }
    globalOffset += node.content.size + 1;
    return false;
  });
  ensure(found !== undefined, 'Corpus edit offset has no text position');
  return found;
}

async function editSample(item: EditorPerformanceUiCase, editor: Editor, index: number) {
  const ydoc = getLiveYDoc(`node-content:${item.nodeId}`);
  ensure(ydoc, 'Live product Y.Doc missing');
  const position = prosePosition(editor, config.editRange.location);
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, position)).scrollIntoView());
  await paintOpportunity();
  let yjsCommitObservedMs: number | null = null;
  let transactionObservedMs: number | null = null;
  const observeYjs = () => { yjsCommitObservedMs ??= now(); };
  const observeTransaction = ({ transaction }: { transaction: { docChanged: boolean } }) => {
    if (transaction.docChanged) transactionObservedMs ??= now();
  };
  ydoc.on('update', observeYjs);
  editor.on('transaction', observeTransaction);
  try {
    await measure('committed-edit-paint-opportunity', item, index, async () => {
      const dispatchStartedMs = now();
      // Ordinary ProseMirror text transaction; all real product plugins and the
      // ySync binding run. This does not synthesize OS keyboard or IME input.
      editor.view.dispatch(editor.state.tr.insertText(config.editText, position, position + config.editRange.length).scrollIntoView());
      const dispatchReturnedMs = now();
      ensure(yjsCommitObservedMs !== null && transactionObservedMs !== null, 'Text transaction did not commit through Tiptap/Yjs');
      const opportunity = await paintOpportunity();
      const firstBlock = editor.view.dom.firstElementChild;
      ensure(firstBlock && firstBlock.textContent === editor.state.doc.firstChild?.textContent, 'Committed text is not present in the editor DOM');
      const bounds = firstBlock.getBoundingClientRect();
      ensure(bounds.bottom > 0 && bounds.top < innerHeight, 'Edited text block is outside the visible viewport');
      return { dispatchStartedMs, dispatchReturnedMs, transactionObservedMs, yjsCommitObservedMs, opportunity,
        dispatchToPaintOpportunityMs: opportunity.observedAtMs - dispatchStartedMs,
        yjsCommitToPaintOpportunityMs: opportunity.observedAtMs - yjsCommitObservedMs,
        dispatchToYjsCommitMs: yjsCommitObservedMs - dispatchStartedMs,
        insertedUtf16: config.editText.length };
    });
  } finally {
    ydoc.off('update', observeYjs);
    editor.off('transaction', observeTransaction);
  }
  // Reset outside every measured window; do not accumulate document growth.
  editor.view.dispatch(editor.state.tr.delete(position, position + config.editText.length));
  await paintOpportunity();
  ensure(plainText(editor).length === item.utf16Length, 'Edit cleanup changed corpus length');
}

async function scrollSample(item: EditorPerformanceUiCase, editor: Editor) {
  const viewport = editor.view.dom.closest<HTMLElement>('.editor-scroll')
    ?? editor.view.dom.closest<HTMLElement>('[data-editor-surface]')?.querySelector<HTMLElement>('.editor-scroll');
  ensure(viewport, 'Actual product editor scroll viewport missing');
  viewport.scrollTop = 0;
  await paintOpportunity();
  await measure('programmatic-scroll', item, 0, async () => {
    const maximum = viewport.scrollHeight - viewport.clientHeight;
    ensure(maximum > 0, 'Corpus has no scrollable height');
    const observations = [];
    for (let step = 1; step <= config.scrollSteps; step++) {
      const fraction = step / config.scrollSteps;
      const targetTop = maximum * (fraction <= 0.5 ? fraction * 2 : (1 - fraction) * 2);
      const requestedAtMs = now();
      viewport.scrollTop = targetTop;
      const frameAtMs = await frame();
      observations.push({ step, targetTop, actualTop: viewport.scrollTop, requestedAtMs, frameAtMs });
    }
    const opportunity = await paintOpportunity();
    return { method: 'actual product viewport scrollTop at animation frames; not physical gesture',
      maximum, viewportHeight: viewport.clientHeight, observations, opportunity };
  });
}

async function settle(item: EditorPerformanceUiCase, label: string) {
  await measure('durable-settling', item, 0, async () => {
    await flushAllYjsDocumentsLocally();
    return { label, boundary: 'product flushAllYjsDocumentsLocally resolved; separate from visible paint' };
  });
}

async function post(payload: object) {
  const response = await fetch(config.endpoint, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` }, body: JSON.stringify(payload) });
  ensure(response.ok, 'Editor performance collector rejected result');
}

const focusTransitions: Record<string, unknown>[] = [];
for (const event of ['focus', 'blur', 'visibilitychange']) {
  window.addEventListener(event, () => focusTransitions.push({ event, atMs: now(), focused: document.hasFocus(), visibility: document.visibilityState }), true);
}
window.addEventListener('error', event => { if (failures.length < 20) failures.push(String(event.message).slice(0, 300)); });
window.addEventListener('unhandledrejection', event => { if (failures.length < 20) failures.push(String(event.reason).slice(0, 300)); });
localStorage.setItem('drifting.alpha-guide.v4:drifting-library.db', 'seen');
useUiStore.setState({ tabsByProject: {}, activeSuperView: 'none' });
location.hash = '/';

async function waitForAttendedStart() {
  // This is an acceptance-only entry, never the shipped application UI. A
  // pointer click gives the native window focus before timing begins; measured
  // operations retain all of their existing visibility/focus assertions.
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '开始合成文档性能测试';
  button.setAttribute('aria-label', button.textContent);
  Object.assign(button.style, { position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)',
    zIndex: '2147483647', padding: '12px 24px', borderRadius: '8px', color: '#111', background: '#fff',
    border: '1px solid #888', fontSize: '16px', cursor: 'pointer' });
  document.body.appendChild(button);
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('No attended performance start within five minutes')), 300_000);
      button.addEventListener('click', () => {
        try { visibleAndFocused(); clearTimeout(timeout); resolve(); }
        catch (error) { clearTimeout(timeout); reject(error); }
      }, { once: true });
    });
  } finally { button.remove(); }
}

async function run() {
  ensure(config.cases.length === 3 && config.samplesPerCase === 30 && config.warmSwitchSamples === 10, 'Unexpected performance sampling contract');
  ensure(config.editRange.length === 0 && config.editText.length === 1, 'This baseline requires a one-unit insertion and exact cleanup');
  const card = await waitFor(() => [...document.querySelectorAll<HTMLElement>('.pp-card')]
    .find(element => element.querySelector('.pp-card__title')?.textContent === `Synthetic ${config.projectId}`), 'synthetic project shelf card');
  const button = card.querySelector<HTMLButtonElement>('.pp-card__hit');
  ensure(button && !button.disabled, 'Shelf project action is unavailable');
  await document.fonts.ready;
  await paintOpportunity();
  button.click();
  await waitFor(() => {
    const state = useDataStore.getState();
    return state.workspaceProjectId === config.projectId && state.workspaceProjectionStatus === 'ready';
  }, 'production workspace projection');
  const runtime = getPlatformRuntime();
  ensure(runtime.isMacDesktop && runtime.appInfo, 'Real macOS Tauri application is required');
  const typography: Record<string, unknown>[] = [];
  for (const item of config.cases) {
    ensure(!getLiveYDoc(`node-content:${item.nodeId}`), `${item.id} was already hydrated before first open`);
    let editor: Editor | undefined;
    await measure('first-document-open', item, 0, async () => {
      editor = await activate(item);
      const opportunity = await paintOpportunity();
      return { opportunity, openedThrough: 'production tab/navigation commands', fontsReady: document.fonts.status === 'loaded' };
    });
    ensure(editor, 'Editor activation failed');
    await verifyCorpus(item, editor);
    baselineEditors.set(item.id, editor);
    baselineYDocs.set(item.id, getLiveYDoc(`node-content:${item.nodeId}`));
    const style = getComputedStyle(editor.view.dom);
    typography.push({ caseId: item.id, fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight,
      width: editor.view.dom.getBoundingClientRect().width, extensions: editor.extensionManager.extensions.map(extension => extension.name) });
    for (let index = 0; index < config.samplesPerCase; index++) await editSample(item, editor, index);
    await verifyCorpus(item, editor);
    await settle(item, 'after committed insertion/cleanup samples');
    await scrollSample(item, editor);
  }
  for (let itemIndex = 0; itemIndex < config.cases.length; itemIndex++) {
    const item = config.cases[itemIndex];
    const alternate = config.cases[(itemIndex + 1) % config.cases.length];
    for (let index = 0; index < config.warmSwitchSamples; index++) {
      await activate(alternate);
      await paintOpportunity();
      await measure('warm-document-switch', item, index, async () => {
        const wasLiveBeforeSwitch = getLiveYDoc(`node-content:${item.nodeId}`) === baselineYDocs.get(item.id);
        const editor = await activate(item);
        const opportunity = await paintOpportunity();
        return { opportunity, wasLiveBeforeSwitch, retainedYDoc: getLiveYDoc(`node-content:${item.nodeId}`) === baselineYDocs.get(item.id),
          retainedEditor: editor === baselineEditors.get(item.id), alternateCaseId: alternate.id };
      });
    }
    const editor = await activate(item);
    await verifyCorpus(item, editor);
    await settle(item, 'after warm switches');
  }
  ensure(failures.length === 0, failures.join('; '));
  longTaskObserver?.disconnect();
  await post({ schemaVersion: 1, kind: 'apple-editor-performance-renderer', status: 'passed',
    corpusSha256: config.corpusSha256, timeOrigin: performance.timeOrigin, browser: navigator.userAgent,
    samples, typography, focusTransitions, failures, viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    limitations: [
      'Packaged production Tauri/WKWebView with acceptance entry; shared runner supplies exact binary/source provenance.',
      'First document open starts at a production tab command; it is not application launch or cold filesystem time.',
      'Text is committed through the real ProseMirror transaction and Yjs binding. OS key delivery, physical IME and photometric display latency are not measured.',
      'Two requestAnimationFrame callbacks identify an opportunity to paint, not proof of displayed pixels. Actual callback cadence is retained.',
      'Insertion cleanup, corpus hashing and durable settling occur outside each edit paint interval. Thirty edits use a constant-length document.',
      'Warm switch records actual Editor/Y.Doc retention; rows with retention=false must not be summarized as retained-view switching.',
      'Long Tasks and JS heap are unavailable when WebKit omits their APIs. Animation-frame gaps are not relabeled as long tasks. Process memory requires host collection.',
      'This local baseline does not accept the complete P2 performance gate or desktop/native feature parity.',
    ] });
}

void waitForAttendedStart().then(run).catch(async error => {
  longTaskObserver?.disconnect();
  await post({ schemaVersion: 1, kind: 'apple-editor-performance-renderer', status: 'failed', corpusSha256: config.corpusSha256,
    message: String(error), samples, failures, focusTransitions, observedAtMs: now(),
    focused: document.hasFocus(), visibility: document.visibilityState });
}).catch(() => undefined);
