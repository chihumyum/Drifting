import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { BlockId } from '../lib/extensions/block-id';
import { applyInlineEdit, type InlineEditResult } from '../lib/copilot/inline-edit';
import { captureInlineSpanSource, trackInlineEditSpan } from '../lib/copilot/inline-edit-apply';
import { diffChars } from '../lib/copilot/text-diff';
import { closeHistory } from '@tiptap/pm/history';
import Collaboration from '@tiptap/extension-collaboration';
import { yUndoPluginKey } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { Plugin, PluginKey } from '@tiptap/pm/state';

async function collaborativeHistory() {
  const doc = new Y.Doc(); const paragraph = new Y.XmlElement('paragraph'); paragraph.setAttribute('id', 'synthetic-copilot-history');
  paragraph.insert(0, [new Y.XmlText('Synthetic prose.')]); doc.getXmlFragment('default').insert(0, [paragraph]);
  const root = document.createElement('div'); document.body.append(root);
  const editor = new Editor({ element: root, extensions: [StarterKit.configure({ undoRedo: false }), Collaboration.configure({ document: doc }), BlockId] });
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  try {
    const manager = yUndoPluginKey.getState(editor.state)!.undoManager; manager.clear(); const original = JSON.stringify(editor.getJSON());
    editor.view.dispatch(editor.state.tr.insertText('!', 1)); const authored = JSON.stringify(editor.getJSON());
    const result: InlineEditResult = { refused: false, reason: '', span: { from: 1, to: 11, oldText: '!Synthetic', newText: 'Revised', diff: [], source: captureInlineSpanSource(editor.state.doc, 1, 11) } };
    if (!applyInlineEdit(editor, result)) throw new Error('Current Yjs proposal rejected'); const applied = JSON.stringify(editor.getJSON());
    editor.view.dispatch(editor.state.tr.insertText('?', 2));
    if (manager.undoStack.length !== 3 || !editor.commands.undo() || JSON.stringify(editor.getJSON()) !== applied
      || !editor.commands.undo() || JSON.stringify(editor.getJSON()) !== authored
      || !editor.commands.undo() || JSON.stringify(editor.getJSON()) !== original) throw new Error('Yjs proposal merged with surrounding author input');
    const liveText = (doc.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText;
    const observers = new Set<unknown>(); let additions = 0; let removals = 0;
    const observe = liveText.observe.bind(liveText); const unobserve = liveText.unobserve.bind(liveText);
    liveText.observe = listener => { observers.add(listener); additions++; observe(listener); };
    liveText.unobserve = listener => { if (observers.delete(listener)) removals++; unobserve(listener); };
    const peer = new Y.Doc(); Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const peerText = (peer.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText;
    try {
      const source = captureInlineSpanSource(editor.state.doc, 1, 10)!; const release = trackInlineEditSpan(editor, source);
      try {
        peerText.insert(0, 'Synthetic '); Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer), 'synthetic-peer');
        const mapped: InlineEditResult = { refused: false, reason: '', span: { from: 1, to: 10, oldText: 'Synthetic', newText: 'Revised', diff: [], source } };
        if (!applyInlineEdit(editor, mapped) || editor.getText() !== 'Synthetic Revised prose.') throw new Error('Yjs repeated peer prefix stole or invalidated an untouched span');
      } finally { release(); }
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
      const replacedSource = captureInlineSpanSource(editor.state.doc, 11, 18)!; const releaseReplaced = trackInlineEditSpan(editor, replacedSource);
      try {
        const before = JSON.stringify(editor.getJSON());
        peer.transact(() => { peerText.delete(12, 1); peerText.insert(12, 'v'); }); Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer), 'synthetic-peer');
        const result: InlineEditResult = { refused: false, reason: '', span: { from: 11, to: 18, oldText: 'Revised', newText: 'Changed', diff: [], source: replacedSource } };
        if (JSON.stringify(editor.getJSON()) !== before || applyInlineEdit(editor, result) || JSON.stringify(editor.getJSON()) !== before) throw new Error('Identical interior peer replacement revived the old proposal');
      } finally { releaseReplaced(); }
      if (additions !== 2 || removals !== 2 || observers.size) throw new Error('Inline Yjs source observers leaked');
      return { separateUndoItems: 3, exactOriginalRestored: true, mappedCollaborativeSpan: true, sameTextPeerReplacementRejected: true, yjsObservers: { additions, removals, remaining: observers.size } };
    } finally { liveText.observe = observe; liveText.unobserve = unobserve; peer.destroy(); }
  } finally { editor.destroy(); doc.destroy(); root.remove(); }
}

export async function runInlineEditApplyScenarios() {
  const checks: string[] = [];
  const root = document.createElement('div'); document.body.append(root);
  const editor = new Editor({ element: root, extensions: [StarterKit, BlockId], content: { type: 'doc', content: [
    { type: 'paragraph', attrs: { id: 'synthetic-apply-a' }, content: [{ type: 'text', text: 'Synthetic first.' }] },
    { type: 'paragraph', attrs: { id: 'synthetic-apply-b' }, content: [{ type: 'text', text: 'Synthetic second.' }] },
    { type: 'paragraph', attrs: { id: 'synthetic-apply-c' }, content: [{ type: 'text', text: 'Synthetic third.' }] },
  ] } });
  await Promise.resolve();
  const original = editor.getJSON();
  const releases: Array<() => void> = [];
  const releaseSources = () => { releases.splice(0).forEach(release => release()); };
  const reset = () => { releaseSources(); editor.setEditable(true); editor.commands.setContent(original); editor.view.dispatch(closeHistory(editor.state.tr)); };
  const check = (name: string, valid: unknown) => { if (!valid) throw new Error(`Inline edit apply: ${name}`); checks.push(name); };
  const span = (from = 1, to = 10, newText = 'Revised') => {
    const oldText = editor.state.doc.textBetween(from, to);
    const source = captureInlineSpanSource(editor.state.doc, from, to);
    if (source) releases.push(trackInlineEditSpan(editor, source));
    return { refused: false, reason: 'Synthetic span proposal', span: { from, to, oldText, newText, diff: diffChars(oldText, newText), source } };
  };
  const blocks = (): InlineEditResult => ({ refused: false, reason: 'Synthetic block proposal', blocks: [0, 1].map(index => {
    const node = editor.state.doc.child(index); const oldText = node.textContent; const newText = `Synthetic revision ${index}.`;
    return { id: node.attrs.id, kind: node.type.name, oldText, newText, diff: diffChars(oldText, newText), changed: true, sourceJson: JSON.stringify(node.toJSON()) };
  }) });
  const reject = (name: string, proposal: InlineEditResult) => {
    const before = JSON.stringify(editor.getJSON());
    check(name, !applyInlineEdit(editor, proposal) && JSON.stringify(editor.getJSON()) === before);
  };
  try {
    const stale = span(); editor.view.dispatch(editor.state.tr.insertText('Author change', 1, 10));
    reject('changed span cannot be overwritten by an old proposal', stale);
    reset(); const formatted = span(); editor.view.dispatch(editor.state.tr.addMark(1, 10, editor.schema.marks.bold.create()));
    reject('formatting added to the span is preserved on conflict', formatted);
    reset(); const moved = span(); editor.view.dispatch(editor.state.tr.insert(0, editor.schema.nodes.paragraph.create({ id: 'synthetic-prefix' }, editor.schema.text('Synthetic first.'))));
    check('span follows its original block after an identical prefix insertion', applyInlineEdit(editor, moved) && editor.state.doc.child(0).textContent === 'Synthetic first.' && editor.state.doc.child(1).textContent === 'Revised first.');
    reset(); const repeated = span(); editor.view.dispatch(editor.state.tr.insertText('Synthetic ', 1));
    check('repeated text before the span cannot steal its mapped target', applyInlineEdit(editor, repeated) && editor.state.doc.firstChild?.textContent === 'Synthetic Revised first.');
    reset(); const replaced = span(); editor.view.dispatch(editor.state.tr.insertText('Synthetic', 1, 10));
    reject('same-text replacement permanently invalidates the original span', replaced);
    reset(); const restored = span(); editor.view.dispatch(editor.state.tr.insertText('!', 4)); editor.commands.undo();
    reject('undo to original content cannot revive an invalidated span', restored);
    reset(); const appendedKey = new PluginKey('synthetic-inline-appended');
    const appended = new Plugin({ key: appendedKey, appendTransaction(transactions, _old, state) {
      if (transactions.some(tr => tr.getMeta('synthetic-inline-replacement'))) return state.tr.insertText('Synthetic', 1, 10);
      return null;
    } });
    editor.registerPlugin(appended); const appendedSource = span(); editor.view.dispatch(editor.state.tr.setMeta('synthetic-inline-replacement', true));
    reject('appended same-text replacement also invalidates the span', appendedSource); editor.unregisterPlugin(appendedKey);
    reset(); const detached = span(); releaseSources(); reject('detached span tracking cannot apply an old result', detached);
    reset(); const whitespace = span(1, 16); editor.view.dispatch(editor.state.tr.insertText(' ', 10));
    reject('whitespace changes remain a real conflict', whitespace);
    reset(); const invalid = span(); invalid.span.from = -1; reject('invalid span rejects without a transaction', invalid);
    reset(); const crossBlock = span(); crossBlock.span.to = editor.state.doc.child(0).nodeSize + 3; reject('span cannot cross into another block', crossBlock);
    reset(); editor.view.dispatch(editor.state.tr.insertText('!', 1));
    const live = span(1, 11, '<b>Literal</b>'); const beforeLive = JSON.stringify(editor.getJSON());
    check('current span writes model output as literal prose', applyInlineEdit(editor, live) && editor.state.doc.firstChild?.textContent === '<b>Literal</b> first.' && !editor.isActive('bold'));
    const appliedSpan = JSON.stringify(editor.getJSON()); editor.view.dispatch(editor.state.tr.insertText('?', 2));
    check('following author input has its own undo operation', editor.commands.undo() && JSON.stringify(editor.getJSON()) === appliedSpan);
    check('current span undo preserves immediately preceding author input', editor.commands.undo() && JSON.stringify(editor.getJSON()) === beforeLive);
    reset(); const untouched = span(); const finalPos = editor.state.doc.content.size - 1; editor.view.dispatch(editor.state.tr.insertText(' External', finalPos));
    check('unrelated later prose does not invalidate a current span', applyInlineEdit(editor, untouched) && editor.getText().includes('Revised first.') && editor.getText().endsWith('Synthetic third. External'));
    reset(); const deletedBlock = blocks(); const secondStart = editor.state.doc.child(0).nodeSize;
    editor.view.dispatch(editor.state.tr.delete(secondStart, secondStart + editor.state.doc.child(1).nodeSize));
    reject('missing block rejects the whole proposal without partial application', deletedBlock);
    reset(); const changedBlock = blocks(); editor.view.dispatch(editor.state.tr.insertText(' Author', editor.state.doc.child(0).nodeSize + 1));
    reject('one changed target rejects every proposed block', changedBlock);
    reset(); const markedBlock = blocks(); editor.view.dispatch(editor.state.tr.addMark(1, 10, editor.schema.marks.italic.create()));
    reject('block source includes formatting in its precondition', markedBlock);
    reset(); const duplicate = blocks(); duplicate.blocks!.push({ ...duplicate.blocks![0] }); reject('duplicate target identities cannot be applied twice', duplicate);
    reset(); const unchanged = blocks(); unchanged.blocks![1].changed = false; unchanged.blocks![1].newText = unchanged.blocks![1].oldText;
    editor.view.dispatch(editor.state.tr.insertText(' Author', editor.state.doc.child(0).nodeSize + 1));
    reject('the complete authored target is checked even when one block has no proposed change', unchanged);
    reset(); const current = blocks(); const beforeBlocks = JSON.stringify(editor.getJSON());
    check('current block proposal commits every target together', applyInlineEdit(editor, current) && editor.state.doc.child(0).textContent === 'Synthetic revision 0.' && editor.state.doc.child(1).textContent === 'Synthetic revision 1.' && editor.state.doc.child(2).textContent === 'Synthetic third.');
    check('multi-block edit is one undo operation with original identities', editor.commands.undo() && JSON.stringify(editor.getJSON()) === beforeBlocks);
    reset(); const relocated = blocks(); editor.view.dispatch(editor.state.tr.insert(0, editor.schema.nodes.paragraph.create({ id: 'synthetic-prefix' }, editor.schema.text('Synthetic untouched prefix.'))));
    check('stable block identities allow an unrelated prefix insertion', applyInlineEdit(editor, relocated) && editor.state.doc.child(0).textContent === 'Synthetic untouched prefix.' && editor.state.doc.child(1).textContent === 'Synthetic revision 0.' && editor.state.doc.child(2).textContent === 'Synthetic revision 1.');
    reset(); const noChanges = blocks(); for (const b of noChanges.blocks!) { b.changed = false; b.newText = b.oldText; }
    const beforeNoop = JSON.stringify(editor.getJSON()); check('a current unchanged result is a prose no-op', applyInlineEdit(editor, noChanges) && JSON.stringify(editor.getJSON()) === beforeNoop);
    reset(); const readonly = span(); editor.setEditable(false); reject('readonly editor cannot accept a proposal', readonly);
    editor.setEditable(true); const destroyed = span(); const beforeDestroy = JSON.stringify(editor.getJSON()); editor.destroy();
    check('destroyed editor rejects without accessing its view', !applyInlineEdit(editor, destroyed) && JSON.stringify(editor.getJSON()) === beforeDestroy);
    return { checks, collaborativeHistory: await collaborativeHistory(), scope: 'Real ProseMirror/Tiptap/Yjs proposals and transactions in isolated Chromium; exact target conflicts, literal text and undo. No provider request or native input.' };
  } finally { releaseSources(); if (!editor.isDestroyed) editor.destroy(); root.remove(); }
}
