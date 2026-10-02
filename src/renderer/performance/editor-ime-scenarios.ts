import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import * as Y from 'yjs';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import { EntityEditorSession } from '../features/editor/entity-editor-session';
import { TypewriterScrollController } from '../features/editor/typewriter-scroll';
import { EntityLink, flushPendingAutoDetect } from '../lib/extensions/entity-link';

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function ensure(value: unknown, message: string): void { if (!value) throw new Error(message); }

/** Real PM composition state and live Yjs; OS candidate UI is outside this harness. */
export async function runEditorImeScenarios() {
  const profiles = [];
  for (const characters of [5_000, 50_000, 200_000]) {
    const viewport = document.createElement('div');
    viewport.className = 'editor-scroll';
    viewport.style.cssText = 'height:320px;overflow:auto;width:700px';
    const host = document.createElement('div'); viewport.append(host); document.body.append(viewport);
    const doc = new Y.Doc();
    const editor = new Editor({ element: host, extensions: [
      StarterKit.configure({ undoRedo: false }), Collaboration.configure({ document: doc }),
      EntityLink.configure({ autoDetectEnabled: true, autoDetectTargets: new Map([['远山', { kind: 'element', id: 'synthetic-person' }]]) }),
    ] });
    editor.commands.setContent({ type: 'doc', content: Array.from({ length: characters / 100 }, () => ({
      type: 'paragraph', content: [{ type: 'text', text: '合成正文'.repeat(25) }],
    })) });
    const session = new EntityEditorSession(editor, { projectId: 'synthetic-ime', sourceKind: 'node', sourceId: 'synthetic-chapter' });
    const typewriter = new TypewriterScrollController(editor);
    let serializations = 0, saves = 0, geometryReads = 0, savedJson = '';
    const getJSON = editor.getJSON.bind(editor);
    const coords = editor.view.coordsAtPos.bind(editor.view);
    editor.getJSON = () => { serializations++; return getJSON(); };
    editor.view.coordsAtPos = (...args) => { geometryReads++; return coords(...args); };
    session.updateOptions({ onPersist: (_editor, derived) => { saves++; savedJson = derived.pmJson; }, selectionKey: null, autoFocus: true, isCommandActive: true });
    session.attach();
    const disposeTypewriter = typewriter.attach();
    try {
      editor.view.focus();
      editor.commands.setTextSelection(1);
      // Schedule a frame first: composition may begin before it executes.
      typewriter.setPresentation({ isVisible: true, isPreparing: false }, 50);
      editor.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      ensure(editor.view.composing, 'PM did not enter composition');
      editor.view.dispatch(editor.state.tr.insertText('远山候选', 1));
      flushPendingAutoDetect(editor); // Explicit auto-link callers must also yield.
      const beforeScroll = viewport.scrollTop;
      await pause(1300); // Exceeds 400 ms persistence and 500 ms linking timers.
      ensure(editor.view.composing, 'Derived work interrupted composition');
      ensure(serializations === 0 && saves === 0, 'Serialized an in-progress IME draft');
      ensure(geometryReads === 0 && viewport.scrollTop === beforeScroll, 'Typewriter moved or measured the marked-text caret');
      ensure(!editor.view.dom.querySelector('.entity-link'), 'Auto-link modified composing text');
      ensure(!editor.view.dom.hasAttribute('data-typewriter-caret-repaint'), 'Typewriter hid the composing caret');
      ensure(editor.schema.nodeFromJSON(yDocToProsemirrorJSON(doc, 'default')).eq(editor.state.doc), 'Composition stopped live Yjs updates');
      const duringComposition = { serializations, saves, geometryReads, autoLinks: 0, focusRetained: document.activeElement === editor.view.dom, liveYjsPreserved: true };

      editor.view.dispatch(editor.state.tr.insertText('远山定稿', 1, 5));
      editor.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '远山定稿' }));
      ensure(!editor.view.composing, 'PM did not finish composition');
      await pause(1300);
      ensure(editor.state.doc.textContent.startsWith('远山定稿'), 'Committed Chinese text changed');
      ensure(editor.view.dom.querySelectorAll('.entity-link').length === 1, 'Committed name was not linked exactly once');
      ensure(saves > 0 && savedJson === JSON.stringify(getJSON()), 'Committed prose projection was not saved');
      ensure(geometryReads > 0, 'Typewriter did not resume after compositionend');
      ensure(document.activeElement === editor.view.dom, 'Committed projection lost focus');
      const replay = new Y.Doc();
      try {
        Y.applyUpdate(replay, Y.encodeStateAsUpdate(doc));
        // Yjs omits default null mark attributes; compare schema-normalized
        // documents, including every text node, mark and attribute.
        ensure(editor.schema.nodeFromJSON(yDocToProsemirrorJSON(replay, 'default')).eq(editor.schema.nodeFromJSON(JSON.parse(savedJson))), 'Yjs replay differs from final projection');
      } finally { replay.destroy(); }
      profiles.push({ characters, candidatePauseMs: 1300, duringComposition,
        afterCommit: { saves, autoLinks: 1, typewriterResumed: true, focusRetained: true, finalProjectionMatchesYjsReplay: true } });
    } finally {
      disposeTypewriter(); session.detach(); editor.destroy(); doc.destroy(); viewport.remove();
    }
  }
  return { profiles, scope: 'Real Tiptap/ProseMirror/Yjs, DOM composition events and synthetic document transactions in isolated Chromium; no native macOS candidate window, WebKit, SQLite durability or physical input latency claim.' };
}
