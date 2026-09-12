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
import { editorTabSelectionKey, getEditorSelectionSnapshot, hasEditorSelectionSnapshot } from '../src/renderer/lib/editor-selection-memory';
import { i18next } from '../src/renderer/lib/i18n';
import { createCommentWithSync, deleteCommentWithSync } from '../src/renderer/usecase/synced-entity-commands';
import { withAtomicSyncTransaction } from '../src/renderer/usecase/sync-helpers';
import { createCommentRepository } from '../src/renderer/sqlite-repo/comment-repo';
import { addCommentToStickyNoteRail, removeCommentFromAllStickyNoteRails } from '../src/renderer/hooks/useEntityStickyNoteRail';
import type { Comment } from '../src/renderer/domain/comment';
import { yUndoPluginKey } from '@tiptap/y-tiptap';
import { useSettingsStore } from '../src/renderer/store/settings-store';

declare const __DRIFTING_NATIVE_ACCEPTANCE__: {
  endpoint: string; token: string;
  editorSessions: boolean;
  typewriter: boolean;
  outline: boolean;
  markers: boolean;
  selectionMemory: boolean;
  contextMenus: boolean;
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
const markerInstances = new WeakMap<object, number>();
const markerObservations: Array<{ surface: string; counts: Record<string, number> }> = [];
const selectionObservations: Record<string, number> = {};
const contextMenuInstances = new WeakMap<object, number>();
const contextMenuObservations: Array<{ surface: string; counts: Record<string, number> }> = [];
let step = 'bootstrap';
Object.assign(globalThis, {
  __nativeAcceptanceContextMenuEvent(owner: { editor: { isDestroyed: boolean; view: { dom: HTMLElement } } }, event: string) {
    let index = contextMenuInstances.get(owner);
    if (index === undefined) {
      index = contextMenuObservations.length; contextMenuInstances.set(owner, index);
      contextMenuObservations.push({ surface: '', counts: {} });
    }
    const row = contextMenuObservations[index];
    if (!owner.editor.isDestroyed) row.surface = owner.editor.view.dom.closest<HTMLElement>('[data-editor-surface]')?.dataset.editorSurface ?? row.surface;
    row.counts[event] = (row.counts[event] ?? 0) + 1;
  },
  __nativeAcceptanceSelectionEvent(event: string) { selectionObservations[event] = (selectionObservations[event] ?? 0) + 1; },
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
  __nativeAcceptanceMarkerEvent(owner: { root: HTMLElement }, event: string) {
    let index = markerInstances.get(owner);
    if (index === undefined) {
      index = markerObservations.length; markerInstances.set(owner, index);
      markerObservations.push({ surface: '', counts: {} });
    }
    const row = markerObservations[index];
    row.surface = owner.root.closest<HTMLElement>('[data-editor-surface]')?.dataset.editorSurface ?? row.surface;
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
  // Wait for canonical initialization to paint before synthetic user focus.
  await frames(); dom.focus();
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
    const listeningMarkers = () => markerObservations.filter(row => (row.counts.resume ?? 0) > (row.counts.pause ?? 0));
    const markerCommentIds: string[] = [];
    if (config.markers) {
      ensure(markerObservations.length >= 20 && listeningMarkers().length === 0 && markerObservations.every(row => !row.counts.measure), 'Empty marker owners performed layout work');
      checks.markersEmptyOwnersIdle = true;
    }
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
    if (config.selectionMemory) {
      await progress('selection-memory-and-hidden-mapping');
      const key = editorTabSelectionKey(a.id, { entityType: 'node', id: a.nodeIds[0] });
      const captures = selectionObservations.capture ?? 0;
      const writes = selectionObservations.write ?? 0;
      for (let index = 0; index < 200; index++) first.commands.setTextSelection({ from: index + 101, to: index + 11 });
      const snapshot = getEditorSelectionSnapshot(key);
      ensure(snapshot && snapshot.anchor === 300 && snapshot.head === 210 && Object.keys(snapshot).sort().join(',') === 'anchor,focusOnRestore,head', 'Selection memory retained wrong positions or prose fields');
      ensure(selectionObservations.capture - captures === 200 && selectionObservations.write - writes === 200, 'Selection burst was not captured exactly once per move');
      checks.selectionCaptureBounded = true;
      await open(a.id, a.nodeIds[2]);
      ensure(await open(a.id, a.nodeIds[0]) === first, 'Selection navigation recreated editor');
      ensure(first.state.selection.anchor === 300 && first.state.selection.head === 210, 'Tab navigation lost backward selection');
      checks.selectionRetainedAcrossTabs = true;
      await open(a.id, a.nodeIds[2]);
      const fragment = doc.getXmlFragment('default');
      const text = (fragment.get(0) as Y.XmlElement).get(0) as Y.XmlText;
      const prefix = 'Synthetic hidden selection prefix. ';
      doc.transact(() => text.insert(0, prefix), 'agent');
      await flushOpenYjsDocument(`node-content:${a.nodeIds[0]}`);
      try {
        await waitFor(() => getEditorSelectionSnapshot(key)?.anchor === 300 + prefix.length && getEditorSelectionSnapshot(key)?.head === 210 + prefix.length, 'mapped hidden selection memory');
      } catch (error) {
        throw new Error(`${String(error)}; selectionDiagnostic=${JSON.stringify({
          snapshot: getEditorSelectionSnapshot(key), selection: first.state.selection.toJSON(),
          textLength: first.getText().length, prefixPresent: first.getText().startsWith(prefix),
          sameDoc: getLiveYDoc(`node-content:${a.nodeIds[0]}`) === doc, destroyed: first.isDestroyed,
        })}`);
      }
      ensure(first.state.selection.anchor === 300 + prefix.length && first.state.selection.head === 210 + prefix.length, 'Hidden snapshot diverged from live selection');
      doc.transact(() => text.delete(0, prefix.length), 'agent');
      await flushOpenYjsDocument(`node-content:${a.nodeIds[0]}`);
      await open(a.id, a.nodeIds[0]);
      ensure(first.state.selection.anchor === 300 && first.state.selection.head === 210 && first.getText() === before + marker, 'Hidden selection cleanup changed source positions/prose');
      ensure(await saveActiveEditor(), 'Selection fixture cleanup save missing');
      checks.hiddenSelectionTracksYjs = true;
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
    if (config.markers) {
      await progress('scroll-markers-membership-and-range');
      const paragraphs = Array.from({ length: 3 }, (_, index) => {
        const paragraph = new Y.XmlElement<{ id: string }>('paragraph');
        paragraph.setAttribute('id', `synthetic-scroll-marker-${index}`);
        paragraph.insert(0, [new Y.XmlText(`Synthetic marker paragraph ${index}. `.repeat(12))]);
        return paragraph;
      });
      doc.transact(() => doc.getXmlFragment('default').insert(0, paragraphs), 'agent');
      await flushOpenYjsDocument(`node-content:${a.nodeIds[0]}`);
      const viewport = first.view.dom.closest<HTMLElement>('.editor-scroll');
      const surface = first.view.dom.closest<HTMLElement>('[data-editor-surface]');
      ensure(viewport && surface, 'Marker viewport missing');
      const block = (index: number) => first.view.dom.querySelector<HTMLElement>(`[data-block-id="synthetic-scroll-marker-${index}"]`)!;
      await waitFor(() => block(2), 'stable marker fixture anchors');
      for (const [index, nodeId] of a.nodeIds.slice(0, 20).entries()) {
        const anchor = document.querySelector<HTMLElement>(`[data-editor-surface="node:${nodeId}"] .ProseMirror [data-block-id]`);
        ensure(anchor?.dataset.blockId, 'Retained marker anchor absent');
        const now = new Date().toISOString();
        const comment: Comment = { id: `native-marker-comment-${index}`, projectId: a.id, kind: 'note', targetKind: 'node', targetId: nodeId,
          targetBlockId: anchor.dataset.blockId, targetBlockIdsJson: '[]', anchorJson: '{}', authorKind: 'user', authorId: null, authorName: null,
          bodyJson: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Synthetic marker acceptance note' }] }] }),
          status: 'open', priority: null, source: 'manual', metadataJson: null, resolvedAt: null, createdAt: now, updatedAt: now };
        await createCommentWithSync(comment);
        if (!useDataStore.getState().comments.some(c => c.id === comment.id)) useDataStore.getState().addComment(comment);
        markerCommentIds.push(comment.id);
        addCommentToStickyNoteRail('node', nodeId, comment.id);
      }
      await waitFor(() => listeningMarkers().length === 1 && surface.querySelector('.editor__scrollmap-tick'), 'one nonempty marker viewport among twenty tabs');
      checks.markersSingleVisibleOwner = true;
      async function patchComment(id: string, patch: Partial<Comment>) {
        const persisted = await withAtomicSyncTransaction(a.id, async (tx, sync) => {
          const record = await createCommentRepository(a.id, tx).update(id, { ...patch, updatedAt: new Date().toISOString() });
          ensure(record, 'Synthetic comment update missing');
          const payload = Object.fromEntries(Object.entries(record).filter(([key]) => !['projectId', 'createdAt', 'updatedAt'].includes(key)));
          await sync('comment', 'update', id, a.id, payload);
          return record;
        });
        useDataStore.getState().updateComment(id, persisted);
      }
      const tick = () => surface.querySelector<HTMLButtonElement>('.editor__scrollmap-tick')!;
      await patchComment(markerCommentIds[0], { targetBlockIdsJson: JSON.stringify(['synthetic-scroll-marker-0', 'synthetic-scroll-marker-1']) });
      await frames();
      tick().focus(); tick().click();
      ensure(block(0).getAnimations().length > 0 && block(1).getAnimations().length > 0 && block(2).getAnimations().length === 0, 'Unchanged first anchor retained the old click range');
      await progress('marker-locale-editor-continuity');
      const locale = i18next.language;
      await i18next.changeLanguage(locale === 'en' ? 'zh-CN' : 'en');
      await waitFor(() => tick().title === i18next.t('editorScrollMarkers.jumpToComment'), 'translated marker title');
      ensure(!first.isDestroyed && getLiveYDoc(`node-content:${a.nodeIds[0]}`) === doc, 'Locale update recreated canonical editor');
      first.commands.setTextSelection({ from: 1, to: 5 });
      first.view.dom.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
      await waitFor(() => document.querySelector('.editor-comment-menu')?.textContent?.includes(i18next.t('entityEditor.contextMenu.format')), 'latest translated context menu');
      await delay(20); document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      await waitFor(() => !document.querySelector('.editor-comment-menu'), 'context menu dismissed');
      first.commands.setTextSelection(first.state.doc.content.size - 1);
      await i18next.changeLanguage(locale);
      ensure(!first.isDestroyed, 'Restoring locale recreated canonical editor');
      await patchComment(markerCommentIds[0], { kind: 'todo' });
      await waitFor(() => tick().classList.contains('editor__scrollmap-tick--c-todo') && tick().title === i18next.t('editorScrollMarkers.jumpToTodo'), 'updated marker family and title');
      checks.markersRangeAndLocale = true;
      await open(a.id, a.nodeIds[2]);
      await frames(); await frames();
      const ownRows = () => markerObservations.filter(row => row.surface === `node:${a.nodeIds[0]}`);
      const hidden = JSON.stringify(ownRows());
      const oldHeight = viewport.style.height; const oldFlex = viewport.style.flex;
      viewport.style.height = '420px'; viewport.style.flex = 'none';
      await patchComment(markerCommentIds[0], { targetBlockId: 'synthetic-scroll-marker-2', targetBlockIdsJson: '["synthetic-scroll-marker-2"]' });
      doc.transact(() => (paragraphs[0].get(0) as Y.XmlText).insert(0, 'Synthetic hidden authored update. '), 'agent');
      await flushOpenYjsDocument(`node-content:${a.nodeIds[0]}`);
      viewport.dispatchEvent(new Event('load')); window.dispatchEvent(new Event('resize'));
      await frames(); await frames();
      ensure(JSON.stringify(ownRows()) === hidden, 'Hidden marker update scheduled or measured layout');
      await open(a.id, a.nodeIds[0]);
      await waitFor(() => tick() && parseFloat(tick().style.top) > 0, 'prepared moved marker on return');
      ensure(JSON.stringify(ownRows()) !== hidden, 'Returning marker geometry was not prepared');
      tick().focus(); tick().click(); ensure(block(2).getAnimations().length > 0, 'Returned marker did not use the current anchor');
      await waitFor(() => {
        const rect = block(2).getBoundingClientRect(); const rootRect = viewport.getBoundingClientRect();
        // A long block may be taller than the viewport. Centering must
        // reveal its middle, rather than requiring the whole block to fit.
        return Math.abs((rect.top + rect.bottom) / 2 - (rootRect.top + rootRect.bottom) / 2) < 4;
      }, 'native smooth marker jump centers target block');
      ensure(getLiveYDoc(`node-content:${a.nodeIds[0]}`) === doc, 'Marker transition recreated prose truth');
      viewport.style.height = oldHeight; viewport.style.flex = oldFlex;
      doc.transact(() => doc.getXmlFragment('default').delete(0, 3), 'agent');
      await flushOpenYjsDocument(`node-content:${a.nodeIds[0]}`);
      const originalAnchor = first.view.dom.querySelector<HTMLElement>('[data-block-id]')?.dataset.blockId;
      ensure(originalAnchor, 'Original block lost after marker cleanup');
      await patchComment(markerCommentIds[0], { targetBlockId: originalAnchor, targetBlockIdsJson: '[]' });
      ensure(await saveActiveEditor(), 'Marker fixture cleanup save missing');
      ensure(first.getText() === before + marker, 'Marker fixture changed original prose');
      ensure(first.commands.undo() && first.getText() === before, 'Locale change lost undo history');
      ensure(first.commands.redo() && first.getText() === before + marker, 'Locale change lost redo history');
      ensure(await saveActiveEditor(), 'Post-locale history save missing');
      checks.markerLocalePreservesEditorAndHistory = true;
      checks.markersHiddenPreparation = true;
    }
    if (config.contextMenus) {
      await progress('context-menu-lifetime');
      const rootMenu = () => document.body.querySelector<HTMLElement>(':scope > .editor-comment-menu');
      const openMenu = async (editor = first) => {
        editor.view.dom.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
        return waitFor(rootMenu, 'actual owned editor context menu');
      };
      const bound = () => contextMenuObservations.filter(row => (row.counts.bind ?? 0) > (row.counts.unbind ?? 0));
      first.commands.setTextSelection({ from: 2, to: 5 });
      for (let index = 0; index < 100; index++) {
        await openMenu(); ensure(bound().length === 1, 'Multiple menus own document listeners');
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        ensure(!rootMenu() && bound().length === 0, 'Closed context menu retained its listener owner');
      }
      checks.menusRepeatedCloseReleases = true;
      const hiddenMenu = await openMenu();
      const staleHeading = [...hiddenMenu.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '一级标题');
      ensure(staleHeading, 'Native heading format action missing');
      const flyoutRow = hiddenMenu.querySelector<HTMLElement>('.has-flyout')!;
      flyoutRow.dispatchEvent(new MouseEvent('mouseenter')); flyoutRow.dispatchEvent(new MouseEvent('mouseleave'));
      const beforeHidden = JSON.stringify(first.getJSON());
      const second = await open(a.id, a.nodeIds[2]);
      ensure(!rootMenu() && bound().length === 0, 'Hidden editor kept its menu');
      staleHeading.click();
      ensure(JSON.stringify(first.getJSON()) === beforeHidden, 'Detached menu action edited the hidden chapter');
      second.commands.setTextSelection({ from: 2, to: 5 }); await openMenu(second);
      await open(a.id, a.nodeIds[0]);
      ensure(!rootMenu() && getLiveYDoc(`node-content:${a.nodeIds[0]}`) === doc, 'Context menu navigation broke editor continuity');
      checks.menusHiddenAndStaleActions = true;
      // Let navigation's DOM focus/selection settle before opening a new menu.
      await frames(); first.commands.setTextSelection({ from: 2, to: 5 });
      const menuEvents: Array<{ kind: string; selection: unknown }> = [];
      const recordUpdate = () => menuEvents.push({ kind: 'update', selection: first.state.selection.toJSON() });
      const recordSelection = () => menuEvents.push({ kind: 'selection', selection: first.state.selection.toJSON() });
      first.on('update', recordUpdate); first.on('selectionUpdate', recordSelection);
      const retainedMenu = await openMenu();
      const retainedSelection = first.state.selection.toJSON();
      useUiStore.getState().closeTab(a.id, { entityType: 'node', id: a.nodeIds[8] });
      await waitFor(() => !getLiveYDoc(`node-content:${a.nodeIds[8]}`), 'unrelated menu owner retired');
      first.off('update', recordUpdate); first.off('selectionUpdate', recordSelection);
      ensure(rootMenu() === retainedMenu && bound().length === 1, `Unrelated editor cleanup removed the current menu; diagnostic=${JSON.stringify({ retainedSelection, menuEvents, destroyed: first.isDestroyed, active: getActiveEditor() === first, menuOwners: contextMenuObservations.filter(row => row.surface === `node:${a.nodeIds[0]}`) })}`);
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      await open(a.id, a.nodeIds[8]); await open(a.id, a.nodeIds[0]);
      checks.menusUnrelatedOwnerCleanup = true;
      const locale = i18next.language;
      await i18next.changeLanguage(locale === 'en' ? 'zh-CN' : 'en'); await frames();
      const beforeFormat = JSON.stringify(first.getJSON()); const prose = first.state.doc.textContent;
      yUndoPluginKey.getState(first.state)?.undoManager.stopCapturing();
      first.commands.setTextSelection({ from: 2, to: 5 });
      const translated = await openMenu();
      ensure(translated.textContent?.includes(i18next.t('entityEditor.contextMenu.format')), 'Owned context menu label is stale');
      [...translated.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '一级标题')!.click();
      ensure(!rootMenu() && first.isActive('heading', { level: 1 }) && first.state.doc.textContent === prose, 'Owned format action changed prose or missed selection');
      const formatUndoManager = yUndoPluginKey.getState(first.state)?.undoManager;
      const formatStructure = () => Array.from({ length: first.state.doc.childCount }, (_, index) => {
        const child = first.state.doc.child(index); return { type: child.type.name, attrs: child.attrs, size: child.content.size };
      });
      const formatted = formatStructure(); const depthBeforeUndo = formatUndoManager?.undoStack.length;
      const formatUndone = first.commands.undo();
      ensure(formatUndone && JSON.stringify(first.getJSON()) === beforeFormat, `Menu formatting lost undo continuity; diagnostic=${JSON.stringify({ formatUndone, depthBeforeUndo, depthAfterUndo: formatUndoManager?.undoStack.length, formatted, afterUndo: formatStructure(), sameText: first.state.doc.textContent === prose, beforeFormat: JSON.parse(beforeFormat).content.map((child: { type: string; attrs: unknown; content?: unknown[] }) => ({ type: child.type, attrs: child.attrs, contentCount: child.content?.length ?? 0 })) })}`);
      await i18next.changeLanguage(locale); await frames();
      ensure(!first.isDestroyed && getLiveYDoc(`node-content:${a.nodeIds[0]}`) === doc, 'Menu locale change recreated canonical editor');
      ensure(await saveActiveEditor(), 'Menu format cleanup save missing');
      checks.menusFormatAndLocale = true;
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
    if (config.markers) {
      await waitFor(() => listeningMarkers().length === 2, 'both visible split marker owners');
      ensure([...document.querySelectorAll('[data-editor-surface-visible="true"]')].every(surface => surface.querySelector('.editor__scrollmap-tick')), 'Visible split lost comment ticks');
      checks.markersVisibleSplit = true;
    }
    if (config.selectionMemory) {
      // A split has one shared surface key, not each leaf's node surface key.
      // SplitView renders left then right; inspect the actual second editor
      // without editorReady, which supplies an explicit focus of its own.
      const splitEditors = [...document.querySelectorAll<HTMLElement>('[data-editor-surface-visible="true"] .ProseMirror[contenteditable="true"]')];
      ensure(splitEditors.length === 2, 'Expected both split editor views');
      await waitFor(() => document.activeElement === splitEditors[1] && getActiveEditor()?.view.dom === splitEditors[1], 'command-active split restoration focus');
      await frames(); await frames();
      ensure(document.activeElement === splitEditors[1], 'Unfocused split stole restoration focus');
      checks.selectionVisibleSplitFocus = true;
    }
    if (config.contextMenus) {
      const splitEditors = [...document.querySelectorAll<HTMLElement>('[data-editor-surface-visible="true"] .ProseMirror[contenteditable="true"]')];
      const menu = () => document.body.querySelector<HTMLElement>(':scope > .editor-comment-menu');
      const context = (dom: HTMLElement) => dom.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
      context(splitEditors[0]); ensure(!menu(), 'Unfocused split opened a custom menu');
      const right = getActiveEditor(); ensure(right?.view.dom === splitEditors[1], 'Wrong active split before menu test');
      right.commands.setTextSelection({ from: 2, to: 5 }); context(splitEditors[1]);
      await waitFor(menu, 'right split menu');
      splitEditors[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 300, clientY: 300 }));
      await frames(); splitEditors[0].focus();
      const left = await waitFor(() => { const active = getActiveEditor(); return active?.view.dom === splitEditors[0] && active; }, 'left split command ownership');
      ensure(!menu(), 'Losing split command ownership retained its menu');
      left.commands.setTextSelection({ from: 2, to: 5 }); context(splitEditors[0]); await waitFor(menu, 'left split menu');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      ensure(!menu(), 'Split Escape retained its menu'); checks.menusSplitCommandOwnership = true;
    }
    useUiStore.getState().clearProjectTabs(a.id);
    location.hash = `/project/${a.id}`;
    await waitFor(() => a.nodeIds.slice(0, 20).every(id => !getLiveYDoc(`node-content:${id}`)), 'closed-tab live document cleanup');
    checks.closedTabsReleaseLiveDocuments = true;
    if (config.contextMenus) {
      ensure(contextMenuObservations.length >= 20 && contextMenuObservations.every(row =>
        row.counts.dispose === 1 && (row.counts.open ?? 0) === (row.counts.close ?? 0) && (row.counts.bind ?? 0) === (row.counts.unbind ?? 0)), 'Closed context menu owners leaked');
      ensure(!document.querySelector('.editor-comment-menu'), 'Closed menu DOM survived');
      checks.menusClosedOwnersReleased = true;
    }
    if (config.typewriter) {
      ensure(listeningTypewriters().length === 0 && typewriterObservations.every(row => row.counts.dispose === 1), 'Closed typewriter owners leaked');
      checks.typewriterClosedOwnersReleased = true;
    }
    if (config.outline) {
      ensure(listeningOutlines().length === 0 && outlineObservations.every(row => row.counts.dispose === 1), 'Closed outline owners leaked');
      checks.outlineClosedOwnersReleased = true;
    }
    if (config.markers) {
      ensure(listeningMarkers().length === 0 && markerObservations.every(row => row.counts.dispose === 1), 'Closed marker owners leaked');
      checks.markersClosedOwnersReleased = true;
      for (const id of markerCommentIds) {
        removeCommentFromAllStickyNoteRails(id);
        await deleteCommentWithSync(a.id, id);
        useDataStore.getState().removeComment(id);
      }
      ensure((await createCommentRepository(a.id).findAll()).length === 0, 'Synthetic comments survived cleanup');
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
    if (config.selectionMemory) {
      await waitFor(() => a.nodeIds.slice(0, 20).every(id => !hasEditorSelectionSnapshot(editorTabSelectionKey(a.id, { entityType: 'node', id }))), 'closed selection memory pruned');
      checks.selectionClosedMemoryPruned = true;
      const reopened = await open(a.id, a.nodeIds[0]);
      reopened.commands.setTextSelection({ from: 35, to: 12 });
      ensure(await saveActiveEditor(), 'Selection restoration setup save missing');
      const saved = getEditorSelectionSnapshot(editorTabSelectionKey(a.id, { entityType: 'node', id: a.nodeIds[0] }));
      ensure(saved?.anchor === 35 && saved.head === 12 && saved.focusOnRestore, 'Project switch setup must capture the focused backward selection');
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
    if (config.selectionMemory) {
      // This project return creates a new canonical editor with saved position
      // memory. Observe the session's automatic focus before open/editorReady
      // can supply an explicit DOM focus of their own.
      await waitFor(() => document.activeElement?.closest<HTMLElement>('[data-editor-surface][data-editor-surface-visible="true"]')?.dataset.editorSurface === `node:${a.nodeIds[0]}`, 'project-return session restoration focus');
      checks.selectionProjectRestoreFocus = true;
    }
    const restored = await open(a.id, a.nodeIds[0]);
    ensure(restored.getText() === before + marker, 'Native reload did not restore committed prose');
    if (config.selectionMemory) {
      ensure(restored.state.selection.anchor === 35 && restored.state.selection.head === 12, 'Project return lost selection direction or offsets');
      checks.selectionProjectRestore = true;
    }
    ensure(useDataStore.getState().bookElements.length === 100 && useDataStore.getState().entityRelations.length === 500, 'Restored project projection incorrect');
    ensure(!getLiveYDoc(`node-content:${b.nodeIds[0]}`), 'Second project doc leaked');
    checks.projectSwitchAndSqliteRestore = true;
    ensure(await saveActiveEditor(), 'Restored editor save callback missing');
    localStorage.setItem('native-acceptance-phase', 'restart');
    await post({ kind: 'observation', syntheticCommandToTwoFramesMs });
  }
  ensure(failures.length === 0, `Uncaught renderer errors: ${failures.join('; ')}`);
  await post({ kind: 'result', status: 'passed', checks, lifecycle, sessionEvents, typewriterObservations, outlineObservations, markerObservations, selectionObservations, contextMenuObservations, firstEditorReadyMs,
    runtime: { target: runtime.target, shellMode: runtime.shellMode, appInfo: runtime.appInfo },
    userAgent: navigator.userAgent, longTasks: supportsLongTasks ? longTasks : null,
    jsHeap: null, uncaughtErrors: failures.length });
}
void run().catch(async error => {
  await post({ kind: 'result', status: 'failed', error: String(error), lifecycle, checks, failures }).catch(() => undefined);
});
