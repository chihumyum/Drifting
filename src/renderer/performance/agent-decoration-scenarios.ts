import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import { closeHistory } from '@tiptap/pm/history';
import { DecorationSet } from '@tiptap/pm/view';
import { createElement, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import * as Y from 'yjs';
import { BlockId } from '../lib/extensions/block-id';
import { AgentDiffDecoration, AgentDiffPluginKey, buildAgentEditorDecorations, planAgentAutoRevealMask } from '../lib/extensions/agent-diff-decoration';
import { useAgentEditStore } from '../store/agent-edit-store';
import { attachAgentDecorationController, type AgentDecorationStore } from '../features/editor/agent-decoration-controller';
import { useAgentEditorDecorations } from '../features/editor/useAgentEditorDecorations';
import { EditorSurfaceLifecycleProvider } from '../components/editor/EditorSurfaceLifecycle';
import { useEditorSurfaceLifecycle, useReportEditorSurfaceReady } from '../components/editor/editor-surface-lifecycle-context';
import type { AgentBlockChange } from '../lib/agent/block-diff';
import '../../styles/comments-review.css';

const prose = { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'block' }, content: [{ type: 'text', text: '合成正文' }] }] };
const change = (): AgentBlockChange => ({ blockId: 'block', op: 'changed', oldText: '旧合成正文', newText: '合成正文', afterPrevId: null });

// Reference effect from 8616d70: subscribe to the entire edit store and always
// dispatch, even for an unrelated entity or an empty decoration projection.
function attachLegacyReference(editor: Editor, id: string) {
  const recompute = () => {
    const state = useAgentEditStore.getState();
    const entry = state.pending[`node:${id}`];
    const addition = state.additions[`node:${id}`];
    const guards = Object.values(state.autoRevealGuards).flatMap((guard) => guard.entityType === 'node' && guard.id === id ? guard.blockIds : []);
    const approve = entry?.changes.filter((item) => !item.field && (item.mode ?? 'approve') === 'approve') ?? [];
    const mask = planAgentAutoRevealMask(entry?.changes ?? [], addition?.revealBlockIds === null, guards);
    const set = approve.length > 0 || mask !== undefined ? buildAgentEditorDecorations(editor.state.doc, approve, mask) : DecorationSet.empty;
    editor.view.dispatch(editor.state.tr.setMeta(AgentDiffPluginKey, set));
  };
  recompute();
  const unsubscribe = useAgentEditStore.subscribe(recompute);
  editor.on('update', recompute);
  return () => { unsubscribe(); editor.off('update', recompute); };
}

export function runAgentDecorationScenarios() {
  const previous = useAgentEditStore.getState();
  const editors: Editor[] = [];
  const containers: HTMLElement[] = [];
  const documents: Y.Doc[] = [];
  const bindings: ReturnType<typeof attachAgentDecorationController>[] = [];
  const legacyDisposers: (() => void)[] = [];
  const checks: { id: string; passed: true }[] = [];
  let activeSubscriptions = 0;
  const counts = { legacy: 0, scoped: 0 };
  const ready: boolean[] = [];
  const errors: unknown[] = [];
  const check = (id: string, valid: boolean) => {
    if (!valid) throw new Error(`Agent decoration acceptance failed: ${id}`);
    checks.push({ id, passed: true });
  };
  const store: AgentDecorationStore = {
    getState: useAgentEditStore.getState,
    subscribe: (listener) => {
      activeSubscriptions++;
      const unsubscribe = useAgentEditStore.subscribe(listener);
      return () => { activeSubscriptions--; unsubscribe(); };
    },
  };
  const create = (doc?: Y.Doc, seed = true) => {
    const element = document.createElement('div');
    document.body.appendChild(element);
    containers.push(element);
    const editor = new Editor({
      element, extensions: [StarterKit.configure({ undoRedo: doc ? false : undefined }), BlockId, AgentDiffDecoration,
        ...(doc ? [Collaboration.configure({ document: doc })] : [])],
      ...(doc ? {} : { content: prose }),
    });
    if (doc && seed) editor.commands.setContent(prose);
    editors.push(editor);
    return editor;
  };
  try {
    useAgentEditStore.getState().clearAll();
    const localDocument = new Y.Doc();
    const remoteDocument = new Y.Doc();
    documents.push(localDocument, remoteDocument);
    const scoped: Editor[] = [];
    for (let index = 0; index < 20; index++) {
      const id = `synthetic-editor-${index}`;
      const legacy = create();
      legacy.on('transaction', ({ transaction }) => { if (transaction.getMeta(AgentDiffPluginKey)) counts.legacy++; });
      legacyDisposers.push(attachLegacyReference(legacy, id));
      const editor = create(index === 1 ? localDocument : undefined);
      scoped.push(editor);
      containers[containers.length - 1].style.visibility = index === 0 ? 'visible' : 'hidden';
      editor.on('transaction', ({ transaction }) => { if (transaction.getMeta(AgentDiffPluginKey)) counts.scoped++; });
      bindings.push(attachAgentDecorationController({
        editor, entityType: 'node', entityId: id, store, presentationNeeded: index === 0,
        onReady: (value) => { ready[index] = value; }, onError: (error) => errors.push(error),
      }));
    }
    counts.legacy = 0; counts.scoped = 0;
    for (let index = 0; index < 100; index++) useAgentEditStore.getState().record('node', 'unrelated', [{ ...change(), newText: `合成${index}` }], 'approve');
    const unrelated = { ...counts };
    check('unrelated-store-updates-do-not-dispatch', unrelated.legacy === 2_000 && unrelated.scoped === 0);
    counts.scoped = 0;
    for (let index = 0; index < 100; index++) scoped[0].view.dispatch(scoped[0].state.tr.insertText('字', 1));
    check('empty-review-input-does-not-dispatch', counts.scoped === 0);

    // Start from the local document alone, then merge an actual remote Yjs edit.
    Y.applyUpdate(remoteDocument, Y.encodeStateAsUpdate(localDocument));
    const remote = create(remoteDocument, false);
    useAgentEditStore.getState().stageAutoRevealGuard('node', 'synthetic-editor-1', 'synthetic-guard', ['block']);
    const hiddenBefore = counts.scoped;
    remote.commands.insertContentAt(1, '远端');
    Y.applyUpdate(localDocument, Y.encodeStateAsUpdate(remoteDocument));
    check('hidden-yjs-update-is-retained', scoped[1].getText().includes('远端'));
    check('hidden-review-work-is-deferred', counts.scoped === hiddenBefore && ready[1] === false);
    bindings[1].setPresentationNeeded(true);
    check('prepare-flushes-mask-before-ready', ready[1] === true && Boolean(scoped[1].view.dom.querySelector('.agent-auto-reveal-pending')));
    const masked = scoped[1].view.dom.querySelector('.agent-auto-reveal-pending')!;
    check('mask-hides-remote-prose', Boolean(masked.textContent?.includes('远端')) && getComputedStyle(masked).opacity === '0' && masked.getBoundingClientRect().height > 0);
    useAgentEditStore.getState().recordReview('node', 'synthetic-editor-1', [change()], 'auto', { effectId: 'synthetic-effect', reviewId: 'synthetic-guard' });
    check('guard-to-durable-projection-keeps-mask', Boolean(scoped[1].view.dom.querySelector('.agent-auto-reveal-pending')));

    const initialProse = JSON.stringify(scoped[0].getJSON());
    scoped[0].commands.setTextSelection(2);
    useAgentEditStore.getState().record('node', 'synthetic-editor-0', [change()], 'approve');
    check('review-does-not-change-prose-or-selection', initialProse === JSON.stringify(scoped[0].getJSON()) && scoped[0].state.selection.from === 2);
    scoped[0].view.dispatch(closeHistory(scoped[0].state.tr));
    scoped[0].commands.insertContent('验');
    scoped[0].commands.undo();
    check('undo-history-survives-decoration-updates', initialProse === JSON.stringify(scoped[0].getJSON()));

    // A forced presentation failure must fail closed, then recover on retry.
    bindings[3].setPresentationNeeded(true);
    scoped[3].view.dom.parentElement!.style.visibility = 'visible';
    check('failure-fixture-starts-visible', getComputedStyle(scoped[3].view.dom).visibility === 'visible');
    const dispatch = scoped[3].view.dispatch.bind(scoped[3].view);
    scoped[3].view.dispatch = () => { throw new Error('synthetic projection failure'); };
    useAgentEditStore.getState().stageAutoRevealGuard('node', 'synthetic-editor-3', 'failure-guard', ['block']);
    check('failed-projection-is-not-ready', ready[3] === false && scoped[3].view.dom.hasAttribute('data-agent-projection-blocked'));
    check('failed-projection-is-hidden', getComputedStyle(scoped[3].view.dom).visibility === 'hidden');
    scoped[3].view.dispatch = dispatch;
    bindings[3].setPresentationNeeded(true);
    check('failed-projection-can-retry', ready[3] === true && !scoped[3].view.dom.hasAttribute('data-agent-projection-blocked') && getComputedStyle(scoped[3].view.dom).visibility === 'visible');
    check('only-injected-failure-was-reported', errors.length === 1);

    for (const binding of bindings) binding.dispose();
    for (const dispose of legacyDisposers) dispose();
    const afterDispose = counts.scoped;
    useAgentEditStore.getState().clearAll();
    scoped[0].commands.insertContent('后');
    check('dispose-releases-listeners-without-destroying-documents', activeSubscriptions === 0 && counts.scoped === afterDispose && scoped.every((editor) => !editor.isDestroyed));
    return { consumers: 20, unrelatedUpdates: 100, unrelated, checks, activeSubscriptionsAfterDispose: activeSubscriptions };
  } finally {
    for (const binding of bindings) binding.dispose();
    // Disposers are idempotent Zustand/Tiptap removals.
    for (const dispose of legacyDisposers) dispose();
    for (const editor of editors) editor.destroy();
    for (const doc of documents) doc.destroy();
    for (const container of containers) container.remove();
    useAgentEditStore.setState(previous, true);
  }
}

export function runDecorationReadinessScenario() {
  const previous = useAgentEditStore.getState();
  const host = document.createElement('div');
  const stage = document.createElement('div');
  document.body.append(host, stage);
  const editor = new Editor({ element: host, extensions: [StarterKit, BlockId, AgentDiffDecoration], content: prose });
  const root = createRoot(stage);
  let reportedReady = false;
  let commandActive = false;
  const reportReady = (value: boolean) => { reportedReady = value; };
  function Consumer() {
    const lifecycle = useEditorSurfaceLifecycle();
    const ready = useAgentEditorDecorations(editor, 'node', 'readiness-editor', lifecycle.isVisible || lifecycle.isPreparing);
    useReportEditorSurfaceReady(ready);
    useLayoutEffect(() => { commandActive = lifecycle.isCommandActive; });
    return null;
  }
  const render = (isVisible: boolean, isPreparing: boolean, isCommandActive: boolean) => flushSync(() => root.render(
    createElement(EditorSurfaceLifecycleProvider, { isVisible, isPreparing, isCommandActive, onReadyChange: reportReady, children: createElement(Consumer) }),
  ));
  try {
    useAgentEditStore.getState().clearAll();
    render(false, false, false);
    flushSync(() => useAgentEditStore.getState().stageAutoRevealGuard('node', 'readiness-editor', 'prepare-guard', ['block']));
    if (reportedReady) throw new Error('Dirty hidden editor reported ready');
    render(false, true, false);
    if (!reportedReady || !editor.view.dom.querySelector('.agent-auto-reveal-pending')) throw new Error('Incoming editor readiness preceded its mask');
    render(true, false, false);
    if (!reportedReady || commandActive) throw new Error('Visible unfocused split lost presentation or acquired commands');
    return { preparedBeforeReveal: true, unfocusedVisiblePaneHasPresentation: true, unfocusedPaneOwnsCommands: false };
  } finally {
    flushSync(() => root.unmount());
    editor.destroy();
    host.remove(); stage.remove();
    useAgentEditStore.setState(previous, true);
  }
}
