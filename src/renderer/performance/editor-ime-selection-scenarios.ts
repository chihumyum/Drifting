import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Collaboration, { isChangeOrigin } from '@tiptap/extension-collaboration';
import type { Transaction } from '@tiptap/pm/state';
import * as Y from 'yjs';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import { BlockId } from '../lib/extensions/block-id';
import { AgentDiffDecoration, AgentDiffPluginKey } from '../lib/extensions/agent-diff-decoration';
import { attachAgentDecorationController } from '../features/editor/agent-decoration-controller';
import { useAgentEditStore } from '../store/agent-edit-store';
import { EntityLink } from '../lib/extensions/entity-link';

/** Driven by CDP Input.imeSetComposition, not hand-dispatched DOM events. */
export function createImeSelectionProbe(review: boolean, linked = false) {
  const previous = useAgentEditStore.getState();
  useAgentEditStore.getState().clearAll();
  const host = document.createElement('div'); document.body.append(host);
  const doc = new Y.Doc();
  const editor = new Editor({ element: host, extensions: [StarterKit.configure({ undoRedo: false }), BlockId,
    AgentDiffDecoration, EntityLink.configure({ autoDetectEnabled: false }), Collaboration.configure({ document: doc })] });
  editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'synthetic-ime-block' },
    content: [{ type: 'text', text: '合成', ...(linked ? { marks: [{ type: 'entityLink', attrs: { targetKind: 'element', targetId: 'synthetic-target' } }] } : {}) },
      { type: 'text', text: '正文' }] }] });
  if (review) useAgentEditStore.getState().record('node', 'synthetic-ime-selection', [{ blockId: 'synthetic-ime-block',
    op: 'changed', oldText: '旧合成正文', newText: '合成正文', afterPrevId: null }], 'approve');
  const controller = attachAgentDecorationController({ editor, entityType: 'node', entityId: 'synthetic-ime-selection',
    store: useAgentEditStore, presentationNeeded: true, onReady: () => {}, onError: error => { throw error; } });
  editor.commands.setTextSelection(5); editor.view.focus();
  let widget = editor.view.dom.querySelector('.agent-diff-del');
  const transactions: { composing: boolean; docChanged: boolean; steps: string[]; review: boolean; sync: boolean }[] = [];
  let decorationTransactions = 0, trustedCompositionStarts = 0;
  const onTransaction = ({ transaction }: { transaction: Transaction }) => {
    if (transaction.getMeta(AgentDiffPluginKey)) decorationTransactions++;
    transactions.push({ composing: editor.view.composing, docChanged: transaction.docChanged,
      steps: transaction.steps.map(step => step.toJSON().stepType), review: Boolean(transaction.getMeta(AgentDiffPluginKey)), sync: isChangeOrigin(transaction) });
  };
  editor.on('transaction', onTransaction);
  const onStart = (event: CompositionEvent) => { if (event.isTrusted) trustedCompositionStarts++; };
  editor.view.dom.addEventListener('compositionstart', onStart);
  const snapshot = () => {
    const selection = document.getSelection();
    return { review, linked, composing: editor.view.composing, trustedCompositionStarts, decorationTransactions, transactions: transactions.slice(),
      originalWidgetConnected: widget?.isConnected ?? null, focused: document.activeElement === editor.view.dom,
      domCollapsed: selection?.isCollapsed, domSelectedText: selection?.toString(),
      pmAnchor: editor.state.selection.anchor, pmHead: editor.state.selection.head,
      text: editor.state.doc.textContent, reviewTint: Boolean(editor.view.dom.querySelector('.agent-diff-changed')),
      yjsMatches: editor.schema.nodeFromJSON(yDocToProsemirrorJSON(doc, 'default')).eq(editor.state.doc) };
  };
  return { snapshot,
    arm() { widget = editor.view.dom.querySelector('.agent-diff-del'); decorationTransactions = 0; transactions.length = 0; return snapshot(); }, dispose() {
    controller.dispose(); editor.off('transaction', onTransaction); editor.view.dom.removeEventListener('compositionstart', onStart);
    editor.destroy(); doc.destroy(); host.remove();
    useAgentEditStore.setState({ pending: previous.pending, additions: previous.additions, autoRevealGuards: previous.autoRevealGuards });
  } };
}

let probe: ReturnType<typeof createImeSelectionProbe> | null = null;
export const imeSelectionProbe = {
  start(review: boolean, linked = false) { probe?.dispose(); probe = createImeSelectionProbe(review, linked); return probe.snapshot(); },
  snapshot() { if (!probe) throw new Error('IME probe is not active'); return probe.snapshot(); },
  arm() { if (!probe) throw new Error('IME probe is not active'); return probe.arm(); },
  stop() { probe?.dispose(); probe = null; },
};
