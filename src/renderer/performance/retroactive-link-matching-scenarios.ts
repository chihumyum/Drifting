import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import { closeHistory, undoDepth } from '@tiptap/pm/history';
import { yUndoPluginKey } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { EntityLink, linkEntityInDoc } from '../lib/extensions/entity-link';

const text = 'abab 😀 A+B';
const target = { kind: 'element' as const, id: 'synthetic-matching-target', names: ['aba', 'bab', '😀', 'A+B', ' A+B ', ''] };
export async function runRetroactiveLinkMatchingScenarios() {
  const checks: { id: string; passed: true }[] = [];
  const check = (id: string, condition: boolean) => { if (!condition) throw new Error(`Retroactive matching: ${id}`); checks.push({ id, passed: true }); };
  for (const mode of ['json', 'yjs'] as const) {
    const doc = new Y.Doc(); const hosts: HTMLElement[] = []; const editors: Editor[] = [];
    const paragraph = new Y.XmlElement('paragraph'); paragraph.insert(0, [new Y.XmlText(text)]); doc.getXmlFragment('default').insert(0, [paragraph]);
    const make = () => {
      const host = document.createElement('div'); document.body.append(host); hosts.push(host);
      const editor = new Editor({ element: host, extensions: [StarterKit.configure({ undoRedo: mode === 'yjs' ? false : undefined }),
        EntityLink.configure({ autoDetectEnabled: false }), ...(mode === 'yjs' ? [Collaboration.configure({ document: doc })] : [])],
        ...(mode === 'json' ? { content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } } : {}) });
      editors.push(editor); return editor;
    };
    try {
      const editor = make(); const hidden = mode === 'yjs' ? make() : null;
      if (hidden) hosts[1].style.display = 'none';
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      const manager = mode === 'yjs' ? yUndoPluginKey.getState(editor.state)!.undoManager : null; manager?.clear();
      const depth = () => manager ? manager.undoStack.length : undoDepth(editor.state);
      const barrier = () => { if (manager) manager.stopCapturing(); else editor.view.dispatch(closeHistory(editor.state.tr)); };
      const links = (view: Editor) => [...view.view.dom.querySelectorAll(`[data-target-id="${target.id}"]`)].map(node => node.textContent);
      editor.view.dispatch(editor.state.tr.insertText('前', 1)); barrier(); const historyBefore = depth();
      linkEntityInDoc(editor, target); const applied = JSON.stringify(editor.getJSON());
      check(`${mode}:literal-overlap-unicode-and-punctuation`, JSON.stringify(links(editor)) === JSON.stringify(['abab', '😀', 'A+B']));
      check(`${mode}:prose-preserved`, editor.state.doc.textContent === '前' + text);
      check(`${mode}:link-not-an-undo-item`, historyBefore === 1 && depth() === historyBefore);
      let updates = 0; const onTransaction = () => { updates++; }; editor.on('transaction', onTransaction);
      linkEntityInDoc(editor, target); editor.off('transaction', onTransaction);
      check(`${mode}:repeat-is-idempotent`, updates === 0 && JSON.stringify(editor.getJSON()) === applied);
      barrier(); editor.view.dispatch(editor.state.tr.insertText('后', editor.state.doc.content.size - 1));
      check(`${mode}:undo-later-keeps-links`, editor.commands.undo() && JSON.stringify(editor.getJSON()) === applied);
      check(`${mode}:undo-earlier-keeps-links`, editor.commands.undo() && editor.state.doc.textContent === text && links(editor).join('|') === 'abab|😀|A+B');
      check(`${mode}:redo-author-keeps-links`, editor.commands.redo() && JSON.stringify(editor.getJSON()) === applied);
      check(`${mode}:editor-instance-retained`, !editor.isDestroyed && editors[0] === editor);
      if (hidden) {
        check('yjs:hidden-view-receives-marks', JSON.stringify(hidden.getJSON()) === applied);
        const peer = new Y.Doc();
        try {
          Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
          check('yjs:independent-replay-keeps-marks', peer.getXmlFragment('default').toString() === doc.getXmlFragment('default').toString() && peer.getXmlFragment('default').toString().includes(target.id));
          const peerText = (peer.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText;
          peerText.insert(0, '远端 '); Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer), 'synthetic-peer');
          check('yjs:remote-update-converges', editor.state.doc.textContent === '远端 前' + text && JSON.stringify(hidden.getJSON()) === JSON.stringify(editor.getJSON()) && links(editor).join('|') === 'abab|😀|A+B');
        } finally { peer.destroy(); }
      }
    } finally { for (const editor of editors) editor.destroy(); for (const host of hosts) host.remove(); doc.destroy(); }
  }
  return { implementation: 'literal-doc-linking', checks, modes: ['json', 'yjs'],
    limitations: ['Headless actual Tiptap editors, local history and in-process Yjs updates; no native input or SQLite restart.', 'Full document traversal and independent alias searches remain; operation/timing comparison is recorded separately.'] };
}
