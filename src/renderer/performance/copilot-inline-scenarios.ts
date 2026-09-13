import { createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { BlockId } from '../lib/extensions/block-id';
import { captureInlineSpanSource } from '../lib/copilot/inline-edit-apply';
import { CopilotInlinePopover } from '../components/copilot/CopilotInlinePopover';
import { useCopilotInlineStore, type CopilotInlineCtx } from '../store/copilot-inline-store';
import { inlineServiceCalls } from './copilot-inline-services';

export async function runInlineCopilotScenarios() {
  const i18n = createInstance(); await i18n.init({ lng: 'en', resources: {}, initImmediate: false });
  const host = document.createElement('div'); const prose = document.createElement('div');
  host.style.transform = 'translateX(30px)'; host.style.overflow = 'hidden';
  document.body.append(host, prose); const root = createRoot(host);
  const editor = new Editor({ element: prose, extensions: [StarterKit, BlockId], content: '<p>Synthetic prose.</p>' });
  const spanListeners = new Set<unknown>();
  const on = editor.on.bind(editor); const off = editor.off.bind(editor);
  const spanTrackers = { additions: 0, removals: 0, remaining: 0, peak: 0 };
  editor.on = (event, listener) => {
    if (event === 'transaction') { spanListeners.add(listener); spanTrackers.additions++; spanTrackers.peak = Math.max(spanTrackers.peak, spanListeners.size); }
    return on(event, listener);
  };
  editor.off = (event, listener) => {
    if (event === 'transaction' && listener && spanListeners.delete(listener)) spanTrackers.removals++;
    return off(event, listener);
  };
  const keyListeners = new Set<EventListenerOrEventListenerObject>();
  const addKey = window.addEventListener.bind(window); const removeKey = window.removeEventListener.bind(window);
  const addDescriptor = Object.getOwnPropertyDescriptor(window, 'addEventListener'); const removeDescriptor = Object.getOwnPropertyDescriptor(window, 'removeEventListener');
  let listenerAdds = 0; let listenerRemoves = 0; let maxKeyListeners = 0;
  window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    if (type === 'keydown' && options === true) { keyListeners.add(listener); listenerAdds++; maxKeyListeners = Math.max(maxKeyListeners, keyListeners.size); }
    addKey(type, listener, options);
  }) as typeof window.addEventListener;
  window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
    if (type === 'keydown' && options === true && keyListeners.delete(listener)) listenerRemoves++;
    removeKey(type, listener, options);
  }) as typeof window.removeEventListener;
  const checks: string[] = [];
  const check = (name: string, valid: unknown) => { if (!valid) throw new Error(`Inline Copilot: ${name}`); checks.push(name); };
  const settle = async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); flushSync(() => {}); };
  const context = (): CopilotInlineCtx => ({ nodeId: 'synthetic-inline-node', projectId: 'synthetic-inline-project', mode: 'block', from: 1, to: 17, selectedText: 'Synthetic prose.', blockContext: 'Synthetic prose.', contextBefore: '', contextAfter: '', segmentSummaries: [], selectionBlockIds: [], targetBlocks: [], spanWithinBlock: false, spanSource: null, clientX: 100, clientY: 100 });
  const render = (mounted = true) => flushSync(() => root.render(mounted ? createElement(StrictMode, {}, createElement(I18nextProvider, { i18n }, createElement(CopilotInlinePopover, { editor, nodeId: 'synthetic-inline-node', projectId: 'synthetic-inline-project' }))) : null));
  const open = () => { const ctx = context(); flushSync(() => useCopilotInlineStore.getState().open(ctx)); return ctx; };
  const panel = () => document.querySelector<HTMLElement>('[data-copilot-inline]');
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label)!;
  const click = (label: string) => { const target = button(label); check(`available action: ${label}`, target); flushSync(() => target.click()); };
  const instruction = () => {
    const input = document.querySelector<HTMLTextAreaElement>('textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Synthetic request');
    flushSync(() => input.dispatchEvent(new Event('input', { bubbles: true })));
  };
  try {
    render(); open(); await settle(); render(false); await settle();
    check('unmount releases the global invocation and its retained prose', useCopilotInlineStore.getState().ctx === null);
    render(); await settle(); check('return does not revive the previous invocation', !document.querySelector('textarea'));
    const first = open(); await settle();
    check('fixed popover portals outside transformed and clipped editor parents', panel()?.parentElement === document.body && panel()?.style.position === 'fixed');
    check('current invocation remains mounted', useCopilotInlineStore.getState().ctx === first && panel());
    const unrelatedHost = document.createElement('div'); document.body.append(unrelatedHost); const unrelatedRoot = createRoot(unrelatedHost);
    try {
      const currentPanel = panel();
      flushSync(() => unrelatedRoot.render(createElement(I18nextProvider, { i18n }, createElement(CopilotInlinePopover, { editor, nodeId: 'synthetic-inline-node', projectId: 'synthetic-other-project' }))));
      check('matching node in another project creates no duplicate portal', document.querySelectorAll('[data-copilot-inline]').length === 1);
      flushSync(() => unrelatedRoot.unmount()); await settle();
      check('unrelated owner cleanup preserves the current invocation and portal', panel() === currentPanel && useCopilotInlineStore.getState().ctx === first);
    } finally { unrelatedHost.remove(); }
    instruction(); click('copilotInline.actions.ask');
    check('first controlled stream starts', inlineServiceCalls.asks.length === 1);
    const second = open(); await settle(); instruction(); click('copilotInline.actions.ask');
    check('replacement aborts only the old stream and preserves new context', inlineServiceCalls.asks.length === 2 && inlineServiceCalls.asks[0].signal?.aborted && !inlineServiceCalls.asks[1].signal?.aborted && useCopilotInlineStore.getState().ctx === second);
    inlineServiceCalls.asks[0].resolve('Synthetic obsolete response'); await settle();
    check('obsolete stream cannot clear the new conversation busy state', document.body.textContent?.includes('copilotInline.status.thinking') && !document.body.textContent?.includes('Synthetic obsolete response'));
    inlineServiceCalls.asks[1].resolve('Synthetic current response'); await settle();
    check('current stream completes normally', document.body.textContent?.includes('Synthetic current response') && !document.body.textContent?.includes('copilotInline.status.thinking'));
    open(); await settle(); click('copilotInline.actions.chapterSummary');
    open(); await settle(); click('copilotInline.actions.chapterSummary');
    check('chapter summary calls are controlled without database writes', inlineServiceCalls.summaries.length === 2);
    inlineServiceCalls.summaries[0].resolve({ status: 'written' }); await settle();
    check('old summary completion cannot change a new invocation', button('copilotInline.actions.chapterSummary').disabled && !document.body.textContent?.includes('copilotInline.chapter.written'));
    inlineServiceCalls.summaries[1].resolve({ status: 'no-sections' }); await settle();
    check('current summary completion remains visible', !button('copilotInline.actions.chapterSummary').disabled && document.body.textContent?.includes('copilotInline.chapter.noSections'));
    open(); await settle(); instruction(); click('copilotInline.actions.inlineCursor');
    check('controlled inline edit starts', inlineServiceCalls.edits.length === 1);
    render(false); await settle(); inlineServiceCalls.edits[0].resolve({ refused: true, reason: 'Synthetic obsolete refusal' }); await settle(); render(); await settle();
    check('unmount aborts inline edit and cannot revive a late preview', inlineServiceCalls.edits[0].signal?.aborted && !panel() && useCopilotInlineStore.getState().ctx === null);
    const beforeEdit = JSON.stringify(editor.getJSON());
    const spanCtx = { ...context(), mode: 'selection' as const, spanWithinBlock: true, spanSource: captureInlineSpanSource(editor.state.doc, 1, 17) };
    flushSync(() => useCopilotInlineStore.getState().open(spanCtx)); await settle(); instruction(); click('copilotInline.actions.inlineSelection');
    inlineServiceCalls.edits[1].resolve({ refused: false, reason: 'Synthetic current revision', span: { from: 1, to: 17, oldText: 'Synthetic prose.', newText: 'Synthetic revised.', source: spanCtx.spanSource, diff: [{ type: 'delete', text: 'Synthetic prose.' }, { type: 'insert', text: 'Synthetic revised.' }] } }); await settle();
    click('copilotInline.actions.accept ↵'); await settle();
    check('current edit applies through the real editor and releases its invocation', editor.getText() === 'Synthetic revised.' && !panel() && !useCopilotInlineStore.getState().ctx);
    check('current edit remains one undoable prose change', editor.commands.undo() && JSON.stringify(editor.getJSON()) === beforeEdit);
    const conflictCtx = { ...spanCtx, spanSource: captureInlineSpanSource(editor.state.doc, 1, 17) };
    flushSync(() => useCopilotInlineStore.getState().open(conflictCtx)); await settle(); instruction(); click('copilotInline.actions.inlineSelection');
    editor.view.dispatch(editor.state.tr.insertText('Author change', 1, 6));
    const authored = JSON.stringify(editor.getJSON());
    inlineServiceCalls.edits[2].resolve({ refused: false, reason: '', span: { from: 1, to: 17, oldText: 'Synthetic prose.', newText: 'Obsolete revision', source: conflictCtx.spanSource, diff: [{ type: 'insert', text: 'Obsolete revision' }] } }); await settle();
    click('copilotInline.actions.accept ↵'); await settle();
    check('actual popover reports target conflict without altering author text', JSON.stringify(editor.getJSON()) === authored && document.body.textContent?.includes('copilotInline.errors.selectionChanged'));
    check('conflict feedback cannot retry the invalid captured target', !button('copilotInline.error.retry'));
    click('copilotInline.actions.close'); await settle();
    check('conflict dismissal releases captured context', !panel() && !useCopilotInlineStore.getState().ctx);
    check('author change survives rejected apply and remains undoable', editor.commands.undo() && JSON.stringify(editor.getJSON()) === beforeEdit);
    open(); await settle(); flushSync(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); await settle();
    check('Escape releases current context and portal', useCopilotInlineStore.getState().ctx === null && !panel());
    open(); await settle(); flushSync(() => editor.setEditable(false)); await settle();
    check('readonly transition releases the invocation', !panel() && !useCopilotInlineStore.getState().ctx);
    editor.setEditable(true); await settle(); check('editable return does not revive the old invocation', !panel());
    const foreign = { ...context(), projectId: 'synthetic-other-project' };
    flushSync(() => useCopilotInlineStore.getState().open(foreign)); await settle(); render(false); await settle();
    check('source mismatch remains invisible and cannot clear another project context', !panel() && useCopilotInlineStore.getState().ctx === foreign);
    useCopilotInlineStore.getState().close(); render();
    const original = JSON.stringify(editor.getJSON());
    for (let index = 0; index < 100; index++) { open(); render(false); await settle(); render(); }
    check('100 hide and return cycles leave no invocation, portal or prose changes', !panel() && !useCopilotInlineStore.getState().ctx && JSON.stringify(editor.getJSON()) === original);
    flushSync(() => useCopilotInlineStore.getState().open({ ...spanCtx, spanSource: captureInlineSpanSource(editor.state.doc, 1, 17) })); await settle(); flushSync(() => editor.destroy()); await settle();
    check('editor destruction releases its invocation and portal', !panel() && !useCopilotInlineStore.getState().ctx);
    check('all owned window keyboard listeners are released', keyListeners.size === 0 && listenerAdds === listenerRemoves && maxKeyListeners === 1);
    spanTrackers.remaining = spanListeners.size;
    check('owned span transaction tracking releases on success, conflict and destruction', spanTrackers.peak === 1 && spanTrackers.additions === spanTrackers.removals && spanTrackers.remaining === 0);
    return { checks, conflictFeedback: true, spanTrackers, cycles: 100, listeners: { additions: listenerAdds, removals: listenerRemoves, remaining: keyListeners.size, peak: maxKeyListeners }, services: { edits: inlineServiceCalls.edits.length, asks: inlineServiceCalls.asks.length, summaries: inlineServiceCalls.summaries.length }, scope: 'Actual production React popover and Tiptap in isolated Chromium; deferred service doubles, no external model requests, database writes or native input. StrictMode development effect replay is not inferred from this production build.' };
  } finally {
    flushSync(() => root.unmount()); await settle(); useCopilotInlineStore.getState().close(); if (!editor.isDestroyed) editor.destroy(); host.remove(); prose.remove();
    if (addDescriptor) Object.defineProperty(window, 'addEventListener', addDescriptor); else delete (window as unknown as Record<string, unknown>).addEventListener;
    if (removeDescriptor) Object.defineProperty(window, 'removeEventListener', removeDescriptor); else delete (window as unknown as Record<string, unknown>).removeEventListener;
  }
}
