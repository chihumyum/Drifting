import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Collaboration from '@tiptap/extension-collaboration';
import { yUndoPluginKey } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { EntityEditorSession } from '../features/editor/entity-editor-session';
import { BlockId } from '../lib/extensions/block-id';
import { closeHistory } from '@tiptap/pm/history';
import { EditorContextMenu, type EditorContextMenuOptions } from '../features/editor/editor-context-menu';

function ensure(value: unknown, message: string): void { if (!value) throw new Error(message); }
const labels = { format: 'Synthetic format', addComment: 'Synthetic comment', addPatch: 'Synthetic patch', copilot: 'Synthetic copilot' };

async function runCollaborativeFormats() {
  const doc = new Y.Doc(); const paragraph = new Y.XmlElement('paragraph');
  paragraph.setAttribute('id', 'synthetic-menu-block');
  const text = new Y.XmlText(); text.insert(0, 'Synthetic collaborative formatting.');
  paragraph.insert(0, [text]); doc.getXmlFragment('default').insert(0, [paragraph]);
  const root = document.createElement('div'); document.body.appendChild(root);
  const editor = new Editor({ element: root, extensions: [StarterKit.configure({ undoRedo: false, underline: false }), Underline, Collaboration.configure({ document: doc }), BlockId] });
  const owner = new EditorContextMenu(editor); owner.setEnabled(true);
  const checks: string[] = [];
  const check = (name: string, value: unknown) => { ensure(value, `Collaborative format: ${name}`); checks.push(name); };
  try {
    await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    const manager = yUndoPluginKey.getState(editor.state)!.undoManager; manager.clear();
    const initial = JSON.stringify(editor.getJSON());
    editor.commands.setTextSelection({ from: 2, to: 10 });
    owner.open({ clientX: 100, clientY: 100, labels });
    [...document.querySelectorAll<HTMLButtonElement>('.editor-comment-menu button')].find(item => item.textContent === '一级标题')!.click();
    const formatted = JSON.stringify(editor.getJSON());
    check('heading and generated trailing block enter one Yjs undo item', manager.undoStack.length === 1 && editor.isActive('heading', { level: 1 }));
    check('format undo restores exact content and block identities', editor.commands.undo() && JSON.stringify(editor.getJSON()) === initial);
    check('format redo restores exact content and block identities', editor.commands.redo() && JSON.stringify(editor.getJSON()) === formatted);
    ensure(editor.commands.undo(), 'Return to original paragraph before split'); manager.clear();
    editor.commands.setTextSelection(4); editor.commands.splitBlock();
    const split = JSON.stringify(editor.getJSON());
    const ids = Array.from({ length: editor.state.doc.childCount }, (_, index) => editor.state.doc.child(index).attrs.id);
    check('split creates unique identities in one undo item', ids.length === 2 && ids.every(Boolean) && new Set(ids).size === 2 && manager.undoStack.length === 1);
    check('split undo restores original block', editor.commands.undo() && JSON.stringify(editor.getJSON()) === initial);
    check('split redo restores assigned block identities', editor.commands.redo() && JSON.stringify(editor.getJSON()) === split);
    manager.clear();
    editor.view.dispatch(editor.state.tr.insert(editor.state.doc.content.size, editor.schema.nodes.paragraph.create(null, editor.schema.text('Synthetic excluded write.'))).setMeta('addToHistory', false));
    check('explicitly excluded write assigns IDs without entering history', manager.undoStack.length === 0 && Boolean(editor.state.doc.lastChild?.attrs.id));
    return { checks, scope: 'Real Yjs, Collaboration, StarterKit trailing node and BlockId; synthetic DOM actions.' };
  } finally { owner.dispose(); editor.destroy(); doc.destroy(); root.remove(); }
}

async function runInitialSessionFocus() {
  const root = document.createElement('div'); const otherRoot = document.createElement('div');
  document.body.append(root, otherRoot);
  const editor = new Editor({ element: root, extensions: [StarterKit], content: '<p>Synthetic initialization.</p>' });
  const other = new Editor({ element: otherRoot, extensions: [StarterKit], content: '<p>Synthetic focused split.</p>' });
  const sessions: EntityEditorSession[] = []; const checks: string[] = [];
  const paint = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  try {
    for (const target of [editor, other]) {
      const session = new EntityEditorSession(editor, { projectId: 'synthetic-menu-project', sourceKind: 'node', sourceId: 'synthetic-menu-node' });
      sessions.push(session);
      session.updateOptions({ onPersist: () => undefined, selectionKey: null, autoFocus: false, isCommandActive: target === editor });
      session.attach();
      // The user's focus wins after initialization; no deferred initialization
      // command may blur it or remove this/another editor's DOM selection.
      target.view.focus(); target.commands.setTextSelection({ from: 2, to: 8 });
      await paint();
      ensure(document.activeElement === target.view.dom && target.view.dom.contains(window.getSelection()?.anchorNode ?? null), 'Initialization deferred blur removed user focus or selection');
      checks.push(target === editor ? 'initialization cannot blur a subsequently focused editor' : 'inactive initialization cannot clear another editor selection');
      session.detach();
    }
    return { checks };
  } finally { sessions.forEach(session => session.detach()); editor.destroy(); other.destroy(); root.remove(); otherRoot.remove(); }
}

export async function runEditorContextMenuScenarios() {
  const groups = [];
  for (const count of [1, 5, 20]) {
    const editors: Editor[] = []; const owners: EditorContextMenu[] = []; const roots: HTMLElement[] = [];
    const listeners = new Set<EventListenerOrEventListenerObject>();
    const hideTimers = new Set<number>(); let maxListeners = 0; let additions = 0; let removals = 0;
    const originalAdd = document.addEventListener.bind(document); const originalRemove = document.removeEventListener.bind(document);
    const savedTimeout = window.setTimeout; const savedClear = window.clearTimeout;
    const originalTimeout = savedTimeout.bind(window); const originalClear = savedClear.bind(window);
    const addDescriptor = Object.getOwnPropertyDescriptor(document, 'addEventListener');
    const removeDescriptor = Object.getOwnPropertyDescriptor(document, 'removeEventListener');
    document.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      if ((type === 'mousedown' || type === 'keydown') && options === true) {
        listeners.add(listener); additions++; maxListeners = Math.max(maxListeners, listeners.size);
      }
      originalAdd(type, listener, options);
    }) as typeof document.addEventListener;
    document.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
      if ((type === 'mousedown' || type === 'keydown') && options === true && listeners.delete(listener)) removals++;
      originalRemove(type, listener, options);
    }) as typeof document.removeEventListener;
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout !== 140 || typeof handler !== 'function') return originalTimeout(handler, timeout, ...args);
      const id = originalTimeout(() => { hideTimers.delete(id); handler(...args); }, timeout);
      hideTimers.add(id); return id;
    }) as typeof window.setTimeout;
    window.clearTimeout = ((id?: number) => { if (id !== undefined) hideTimers.delete(id); originalClear(id); }) as typeof window.clearTimeout;
    const menu = () => document.body.querySelector<HTMLElement>(':scope > .editor-comment-menu');
    const checks: string[] = [];
    const check = (name: string, value: unknown) => { ensure(value, `${count} editors: ${name}`); checks.push(name); };
    try {
      for (let index = 0; index < count; index++) {
        const root = document.createElement('div'); document.body.appendChild(root); roots.push(root);
        const editor = new Editor({ element: root, extensions: [StarterKit.configure({ underline: false }), Underline], content: '<p>Synthetic menu selection.</p>' });
        editors.push(editor); owners.push(new EditorContextMenu(editor));
        editor.commands.setTextSelection({ from: 2, to: 10 });
      }
      const owner = owners[0]; const editor = editors[0]; let comments = 0;
      const options: EditorContextMenuOptions = { clientX: 100, clientY: 100, labels, onAddComment: () => comments++ };
      check('inactive owners do not open or subscribe', owners.every(item => !item.open(options)) && listeners.size === 0);
      owner.setEnabled(true);
      for (let index = 0; index < 100; index++) {
        ensure(owner.open(options) && listeners.size === 2, 'Exactly two document listeners while open');
        const action = [...menu()!.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === labels.addComment)!;
        action.click(); action.click();
        ensure(!menu() && listeners.size === 0, 'Action close retained a global listener');
      }
      check('100 action cycles release listeners and reject detached actions', comments === 100 && additions === removals);
      owner.open(options); document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      check('outside click closes synchronously', !menu() && listeners.size === 0);
      owner.open(options); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      check('escape closes synchronously', !menu() && listeners.size === 0);
      owner.open(options);
      const format = menu()!.querySelector<HTMLElement>('.has-flyout')!;
      format.dispatchEvent(new MouseEvent('mouseenter')); format.dispatchEvent(new MouseEvent('mouseleave'));
      ensure(hideTimers.size === 1, 'Expected one hover-hide timer');
      owner.setEnabled(false);
      check('hiding cancels hover timer and global listeners', !menu() && hideTimers.size === 0 && listeners.size === 0);
      await new Promise<void>(resolve => originalTimeout(resolve, 160));
      check('hidden timer cannot recreate a menu', !menu() && hideTimers.size === 0);
      owner.setEnabled(true); owner.open(options); editor.commands.setTextSelection(3);
      check('selection changes invalidate action context', !menu());
      owner.open(options); editor.commands.insertContent('x');
      check('document changes invalidate action context', !menu());
      editor.commands.setTextSelection({ from: 2, to: 10 });
      // Separate this format action from the preceding synthetic prose edit.
      editor.view.dispatch(closeHistory(editor.state.tr));
      const before = editor.state.doc.textContent; owner.open(options);
      const heading = [...menu()!.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === '一级标题')!;
      heading.click();
      // StarterKit may append an empty trailing paragraph after a heading;
      // compare authored text, not getText's extra block-separator newlines.
      check('formatting uses live selection and preserves prose', !menu() && editor.isActive('heading', { level: 1 }) && editor.state.doc.textContent === before);
      ensure(editor.commands.undo(), 'Formatting must remain undoable');
      check('formatting keeps undo continuity', editor.isActive('paragraph') && editor.state.doc.textContent === before);
      editor.setEditable(false); check('read-only editor rejects custom actions', !owner.open(options)); editor.setEditable(true);
      if (count > 1) {
        const incoming = owners[1]; owner.open(options);
        const stale = [...menu()!.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === labels.addComment)!;
        incoming.setEnabled(true); incoming.open({ ...options, labels: { ...labels, format: 'Updated locale label' } });
        const incomingMenu = menu(); owner.dispose(); stale.click();
        check('retiring another owner preserves the incoming menu', menu() === incomingMenu && listeners.size === 2 && comments === 100);
        check('new invocation uses current labels', menu()!.textContent?.includes('Updated locale label'));
        incoming.close(); incoming.open(options); editors[1].destroy();
        check('editor destruction releases its menu and subscriptions', !menu() && listeners.size === 0);
      } else {
        owner.open(options); editor.destroy(); check('editor destruction releases its menu and subscriptions', !menu() && listeners.size === 0);
      }
      owners.forEach(item => item.dispose());
      check('all owners dispose idempotently', !menu() && listeners.size === 0 && hideTimers.size === 0 && additions === removals);
      groups.push({ editors: count, actionCycles: 100, comments, maxDocumentListeners: maxListeners, additions, removals,
        remainingDocumentListeners: listeners.size, remainingHideTimers: hideTimers.size, checks });
    } finally {
      owners.forEach(owner => owner.dispose()); editors.forEach(editor => { if (!editor.isDestroyed) editor.destroy(); }); roots.forEach(root => root.remove());
      if (addDescriptor) Object.defineProperty(document, 'addEventListener', addDescriptor); else delete (document as Partial<Document>).addEventListener;
      if (removeDescriptor) Object.defineProperty(document, 'removeEventListener', removeDescriptor); else delete (document as Partial<Document>).removeEventListener;
      window.setTimeout = savedTimeout; window.clearTimeout = savedClear;
    }
  }
  return { groups, collaborativeFormats: await runCollaborativeFormats(), initialSessionFocus: await runInitialSessionFocus(), scope: 'Actual DOM and Tiptap editors in isolated Chromium; no React shell, native input, or memory/latency budget inferred.' };
}
