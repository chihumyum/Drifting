/* eslint-disable react-refresh/only-export-components -- Standalone production test entry, no Fast Refresh. */
import { useCallback, useRef, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Editor } from '@tiptap/core';
import { EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { PlotPlannerDock } from '../components/editor/PlotPlannerDock';
import { createEmptyPlotGrid, type PlotGridMutation } from '../domain/plot-grid';
import { useEntityEditorSession } from '../features/editor/useEntityEditorSession';
import { getActiveEditor } from '../lib/active-editor';
import { editorTabSelectionKey, getEditorSelectionSnapshot, pruneEditorSelectionMemory, saveEditorSelectionSnapshot } from '../lib/editor-selection-memory';
import { DesktopAgentTranscript } from '../features/agent/desktop/DesktopAgentTranscript';
import { WorkspaceNavigationProvider } from '../features/workspace/navigation/WorkspaceNavigationContext';
import { AgentChatTranscript } from '../domain/agent-chat-transcript';
import { useAgentChatStore } from '../store/agent-chat-store';
import { createAgentChatJournalScope } from '../lib/agent/runtime/chat-journal-dedup';
import { createInactiveAgentAutomaticContinuation } from '../lib/agent/runtime/long-task-auto-continuation';
import { useMeasuredGraphEdges } from '../features/graph/useMeasuredGraphEdges';
import { measureGraphEdges, sameGraphEdgeGeometry } from '../features/graph/graph-edge-geometry';
import { installLifecycleResourceProbe } from './lifecycle-resource-probe';

// The build reads this key expression directly from NodeEditorView.tsx.
// The controlled sibling fixture reproduces React reconciliation without DB ports.
declare const __DRIFTING_PLOT_KEY__: (nodeId: string) => string;
const projectId = 'synthetic-lifecycle-project';
const navigator = { projectId, open() {}, activate() {}, showProjectHome() {}, leaveDeletedTarget() {} };
const i18n = createInstance();
const host = document.createElement('div');
host.style.cssText = 'width:900px;height:700px'; document.body.append(host);
const root = createRoot(host);
const probe = installLifecycleResourceProbe();
let subscriptions = 0, cycles = 0;
const subscribe = useAgentChatStore.subscribe;
useAgentChatStore.subscribe = listener => {
  subscriptions++;
  const unsubscribe = subscribe(listener); let live = true;
  return () => { if (live) { live = false; subscriptions--; unsubscribe(); } };
};
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const render = (children: ReactNode) => flushSync(() => root.render(
  <I18nextProvider i18n={i18n}><WorkspaceNavigationProvider navigator={navigator}>{children}</WorkspaceNavigationProvider></I18nextProvider>,
));
const snapshot = () => ({ ...probe.snapshot(), agentSubscriptions: subscriptions, hostElements: host.querySelectorAll('*').length });
let baseline: ReturnType<typeof snapshot>;

function verifyResourceProbe() {
  const before = probe.snapshot(); const listener = () => undefined;
  window.addEventListener('synthetic-probe', listener);
  const timeout = window.setTimeout(listener, 10000), interval = window.setInterval(listener, 10000), frame = requestAnimationFrame(listener);
  const resize = new ResizeObserver(listener), mutation = new MutationObserver(listener);
  resize.observe(host); mutation.observe(host, { childList: true });
  const pending = probe.snapshot();
  check(Object.keys(before).every(key => pending[key as keyof typeof before] === before[key as keyof typeof before] + 1), 'Resource probe failed to detect injected live resources');
  window.removeEventListener('synthetic-probe', listener);
  window.clearTimeout(timeout); window.clearInterval(interval); cancelAnimationFrame(frame); resize.disconnect(); mutation.disconnect();
  check(JSON.stringify(before) === JSON.stringify(probe.snapshot()), 'Resource probe failed to observe cleanup');
  window.addEventListener('synthetic-once', listener, { once: true }); window.dispatchEvent(new Event('synthetic-once'));
  const controller = new AbortController(); window.addEventListener('synthetic-abort', listener, { signal: controller.signal }); controller.abort();
  check(JSON.stringify(before) === JSON.stringify(probe.snapshot()), 'Resource probe changed once/abort listener lifetime');
}

async function plotCycle(index: number, oldKey = false) {
  const saved: string[] = [];
  const onPersist = async (nodeId: string, changes: readonly PlotGridMutation[]) => {
    check(changes.some(change => change.type === 'row.add'), 'Planner must flush the queued row insertion'); saved.push(nodeId);
  };
  const initialJson = JSON.stringify(createEmptyPlotGrid());
  const show = (nodeId: string, open: boolean) => render(<main className="editor-shell" style={{ height: 650 }}>
    <header>Chapter {nodeId}</header>
    {open && <PlotPlannerDock key={oldKey ? nodeId : __DRIFTING_PLOT_KEY__(nodeId)} nodeId={nodeId} initialJson={initialJson} onPersist={onPersist} />}
    <div className="editor-body" key={nodeId}>Synthetic prose {nodeId}</div>
  </main>);
  for (const suffix of ['a', 'b']) {
    show(`chapter-${index}-${suffix}`, true);
    check(host.querySelectorAll('.plot-planner').length === 1, 'Planner orphan DOM after chapter switch');
    flushSync(() => host.querySelector<HTMLButtonElement>('.plot-planner__add')!.click());
    // Retire during a drag, before mouseup; global resize listeners must detach.
    flushSync(() => host.querySelector('.plot-planner__resize')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientY: 250 })));
  }
  show(`chapter-${index}-b`, false);
  check(host.querySelectorAll('.plot-planner').length === 0, 'Planner orphan DOM after close');
  render(null); await probe.settle();
  check(saved.join(',') === `chapter-${index}-a,chapter-${index}-b`, 'Planner flush crossed chapter ownership or was duplicated');
}

function EditorSessionFixture({ editor, sourceId, visible, onPersist }: { editor: Editor; sourceId: string; visible: boolean; onPersist(): void }) {
  useEntityEditorSession(editor, { projectId, sourceKind: 'node', sourceId, canonicalReady: true,
    presentationNeeded: visible, isCommandActive: visible, selectionKey: editorTabSelectionKey(projectId, { entityType: 'node', id: sourceId }), onPersist });
  return <div hidden={!visible}><EditorContent editor={editor} /></div>;
}
async function editorCycle(index: number) {
  const saved = [0, 0];
  const editors = [0, 1].map(id => new Editor({ extensions: [StarterKit], content: `<p>Synthetic chapter ${index}-${id}</p>` }));
  const ids = [`editor-${index}-a`, `editor-${index}-b`];
  const show = (active: number) => render(<>{editors.map((editor, id) => <EditorSessionFixture key={ids[id]} editor={editor}
    sourceId={ids[id]} visible={active === id} onPersist={() => { saved[id]++; }} />)}</>);
  try {
    show(0); await probe.settle(5);
    editors[0].commands.insertContent(' visible edit');
    show(1); editors[0].commands.insertContent(' hidden edit'); editors[1].commands.insertContent(' second tab');
    for (let id = 0; id < 2; id++) saveEditorSelectionSnapshot(editorTabSelectionKey(projectId, { entityType: 'node', id: ids[id] }), editors[id]);
    show(0); render(null);
    check(saved.every(count => count === 1), 'Closing editor tabs must flush each pending edit once');
    check(getActiveEditor() === null, 'Active editor survived tab unmount');
  } finally {
    render(null); editors.forEach(editor => editor.destroy()); pruneEditorSelectionMemory(projectId, []);
  }
  check(ids.every(id => !getEditorSelectionSnapshot(editorTabSelectionKey(projectId, { entityType: 'node', id }))), 'Closed tab selection retained');
  await probe.settle();
}

async function agentCycle(index: number) {
  const makeRun = (id: string, count: number) => ({ projectId, runtimeSessionId: id, journalScope: createAgentChatJournalScope(),
    transcript: AgentChatTranscript.from(Array.from({ length: count }, (_, row) => ({ kind: 'assistant' as const, text: `**Synthetic ${id} history ${row}**`, streaming: false }))),
    controlStatus: 'running' as const, pendingControl: null, lastTerminal: null, longTaskPlanState: null, contextUsage: null,
    automaticContinuation: createInactiveAgentAutomaticContinuation() });
  const a = `conversation-${index}-a`, b = `conversation-${index}-b`;
  useAgentChatStore.setState({ boundProjectId: projectId, activeConvId: a, runs: { [a]: makeRun(a, 300), [b]: makeRun(b, 3) }, runningTurns: { [a]: 'synthetic-turn' } });
  render(<DesktopAgentTranscript key={a} />);
  check(host.querySelectorAll('.agent-md').length === 300, 'Agent history did not fully mount');
  flushSync(() => useAgentChatStore.setState({ activeConvId: b }));
  render(<DesktopAgentTranscript key={b} />);
  check(host.querySelectorAll('.agent-md').length === 3 && !host.textContent?.includes(`Synthetic ${a}`), 'Agent conversation switch retained previous history');
  flushSync(() => useAgentChatStore.setState({ activeConvId: a }));
  render(<DesktopAgentTranscript key={a} />);
  // Retire with a frame + fallback timer pending; no display work may survive.
  useAgentChatStore.setState(state => ({ runs: { ...state.runs, [a]: { ...state.runs[a],
    transcript: state.runs[a].transcript.append({ kind: 'assistant', text: 'pending stream', streaming: true }) } } }));
  render(null);
  useAgentChatStore.setState({ activeConvId: null, runs: {}, runningTurns: {} });
  await probe.settle();
  check(subscriptions === 0, 'Agent store subscription survived transcript close');
}

function GraphFixture({ revision }: { revision: string }) {
  const viewportRef = useRef<HTMLDivElement>(null), layerRef = useRef<SVGSVGElement>(null), panningRef = useRef(false);
  const measure = useCallback(() => measureGraphEdges([{ id: 'edge', fromKind: 'node', fromId: 'from', toKind: 'node', toId: 'to', relationTypeId: 'synthetic', directed: true, color: 'black' }],
    (_kind, id) => viewportRef.current?.querySelector<HTMLElement>(`[data-endpoint="${id}"]`) ?? undefined), []);
  const geometry = useMeasuredGraphEdges({ measure, equals: sameGraphEdgeGeometry, revision, animationWindowMs: 120,
    layerRef, panningRef, viewportRef, panEndEvent: 'synthetic-pan-end' });
  return <div ref={viewportRef} data-graph-viewport style={{ height: 180 }} onMouseDown={() => { panningRef.current = true; }}><span data-endpoint="from">From</span><span data-endpoint="to">To</span>
    <svg ref={layerRef}>{geometry.map(edge => <line key={edge.id} x1={edge.x1} y1={edge.y1} x2={edge.x2} y2={edge.y2} />)}</svg></div>;
}
async function graphCycle(index: number) {
  render(<GraphFixture revision={`story-${index}`} />); await probe.settle(40);
  check(host.querySelectorAll('line').length === 1, 'Graph edge measurement did not reach DOM');
  flushSync(() => host.querySelector('[data-graph-viewport]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  render(<GraphFixture revision={`element-${index}`} />);
  window.dispatchEvent(new Event('resize')); window.dispatchEvent(new Event('synthetic-pan-end'));
  render(null); await probe.settle();
}

async function cycle(index: number) {
  for (const [name, run] of [['planner', plotCycle], ['editor', editorCycle], ['agent', agentCycle], ['graph', graphCycle]] as const) {
    await run(index);
    if (baseline) check(JSON.stringify(snapshot()) === JSON.stringify(baseline), `${name} resource leak at cycle ${index}: ${JSON.stringify(snapshot())}; baseline ${JSON.stringify(baseline)}`);
  }
}
const harness = {
  async init() {
    await i18n.init({ lng: 'en', resources: {}, initImmediate: false });
    verifyResourceProbe();
    // Warm module caches and React's document-level event registration.
    for (let index = 0; index < 10; index++) await cycle(-index - 1);
    baseline = snapshot();
    check(Object.entries(baseline).every(([key, value]) => key === 'globalListeners' || value === 0), `Warmup retained resources: ${JSON.stringify(baseline)}`);
    return baseline;
  },
  async batch(count: number) { for (let i = 0; i < count; i++) { await cycle(cycles); cycles++; } return { cycles, resources: snapshot() }; },
  async negativeControl() {
    await i18n.init({ lng: 'en', resources: {}, initImmediate: false });
    try { await plotCycle(0, true); return { detected: false }; }
    catch (error) { return { detected: String(error).includes('Planner orphan DOM'), error: String(error) }; }
  },
};
Object.assign(window, { __DRIFTING_LIFECYCLE__: harness });
