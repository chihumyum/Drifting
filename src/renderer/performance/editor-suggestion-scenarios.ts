import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Plugin } from '@tiptap/pm/state';
import { createDefaultSlashMenu } from '../lib/slash-menu';
import { EntityMentionSuggestion } from '../lib/extensions/entity-mention-suggestion';
import { EntityLink } from '../lib/extensions/entity-link';
import { EditorSuggestionGate } from '../lib/editor-suggestion-interaction';

function ensure(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const settle = async () => { await tick(); await tick(); };
type Kind = 'slash' | 'mention';
const popup = (kind: Kind) => document.body.querySelector<HTMLElement>(`[data-editor-suggestion="${kind}"]`);
const firstAction = (kind: Kind) => [...popup(kind)?.querySelectorAll<HTMLButtonElement>('button') ?? []].find(item => kind === 'slash' ? item.textContent === '一级标题' : item.textContent === '元素Synthetic element');
const initial = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Synthetic prose. ' }] }] };
async function open(editor: Editor, kind: Kind, query = '') {
  editor.view.focus(); editor.commands.setContent(initial);
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  editor.commands.insertContent(`${kind === 'slash' ? '/' : '@'}${query}`); await settle();
  ensure(popup(kind), `${kind}: expected suggestion portal`);
}

export async function runEditorSuggestionScenarios() {
  ensure(document.hasFocus(), 'Suggestion DOM events require an active isolated Chromium page');
  const groups = [];
  for (const count of [1, 5, 20]) {
    const editors: Editor[] = []; const gates: EditorSuggestionGate[] = []; const roots: HTMLElement[] = [];
    let itemBuilds = 0; let subscriptions = 0; let releases = 0; let activeSubscriptions = 0; let maxSubscriptions = 0;
    const checks: string[] = [];
    const check = (name: string, value: unknown) => { ensure(value, `${count} editors: ${name}`); checks.push(name); };
    try {
      for (let index = 0; index < count; index++) {
        const root = document.createElement('div'); document.body.appendChild(root); roots.push(root);
        const gate = new EditorSuggestionGate(); gates.push(gate);
        const subscribe = gate.subscribe.bind(gate);
        gate.subscribe = listener => {
          subscriptions++; activeSubscriptions++; maxSubscriptions = Math.max(maxSubscriptions, activeSubscriptions);
          const release = subscribe(listener);
          return () => { releases++; activeSubscriptions--; release(); };
        };
        const editor = new Editor({ element: root, extensions: [StarterKit.configure({ link: false }), EntityLink.configure({ autoDetectEnabled: false }), createDefaultSlashMenu({ gate, extraItems: () => { itemBuilds++; return []; } }), EntityMentionSuggestion.configure({ gate, getEntities: () => { itemBuilds++; return [{ kind: 'element', id: 'synthetic-element', name: 'Synthetic element' }]; } })], content: initial });
        editors.push(editor);
        editor.view.focus(); editor.commands.setTextSelection(editor.state.doc.content.size - 1); editor.commands.insertContent('@Synthetic');
      }
      await settle();
      check('inactive canonical gates build no items or portals', itemBuilds === 0 && !popup('slash') && !popup('mention'));
      const editor = editors[0]; const gate = gates[0]; gate.setEditor(editor);
      for (const kind of ['slash', 'mention'] as const) {
        for (let cycle = 0; cycle < 100; cycle++) {
          await open(editor, kind);
          const stale = firstAction(kind); ensure(stale, `${kind}: expected action`);
          const before = JSON.stringify(editor.getJSON());
          gate.setEditor(null); ensure(!popup(kind), `${kind}: hiding retained portal`);
          stale.click(); ensure(JSON.stringify(editor.getJSON()) === before, `${kind}: stale action changed hidden prose`);
          editor.view.dom.blur();
          editor.view.dispatch(editor.state.tr.setMeta('addToHistory', false));
          gate.setEditor(editor); editor.view.focus();
          editor.commands.setTextSelection(editor.state.selection.from); await settle();
          ensure(!popup(kind), `${kind}: hidden transactions and restored focus revived a dismissed menu`);
        }
        check(`${kind}: 100 hide/return cycles reject stale actions`, !popup(kind));
        await open(editor, kind); const stale = firstAction(kind)!; const before = JSON.stringify(editor.getJSON());
        editor.view.dom.blur(); await settle();
        stale.click(); check(`${kind}: blur closes without editing prose`, !popup(kind) && JSON.stringify(editor.getJSON()) === before);
        await open(editor, kind);
        editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        check(`${kind}: Escape closes without consuming the trigger`, !popup(kind) && editor.getText().endsWith(kind === 'slash' ? '/' : '@'));
        await open(editor, kind); editor.setEditable(false); await settle();
        check(`${kind}: readonly closes the portal`, !popup(kind)); editor.setEditable(true);
        await open(editor, kind); const oldButton = firstAction(kind)!;
        editor.commands.insertContent(kind === 'slash' ? '一' : 'Synthetic'); await settle();
        const changed = JSON.stringify(editor.getJSON()); oldButton.click();
        check(`${kind}: detached rows cannot invoke the refreshed query`, Boolean(popup(kind)) && JSON.stringify(editor.getJSON()) === changed);
        firstAction(kind)!.click(); await settle();
        check(`${kind}: current action consumes its live trigger once`, !popup(kind) && (kind === 'slash' ? editor.isActive('heading', { level: 1 }) : editor.getText().endsWith('Synthetic element ')));
      }
      editor.registerPlugin(new Plugin({}));
      await open(editor, 'slash'); firstAction('slash')!.click(); await settle();
      check('recreated plugin views retain command ownership', editor.isActive('heading', { level: 1 }) && !popup('slash'));
      gate.setEditor(null); const beforeHidden = itemBuilds;
      for (const retained of editors) {
        retained.commands.setContent(initial); retained.commands.setTextSelection(retained.state.doc.content.size - 1);
        retained.commands.insertContent('@Synthetic'); retained.view.dispatch(retained.state.tr.setMeta('addToHistory', false));
      }
      await settle();
      check('hidden authoritative transactions do not build suggestion items', itemBuilds === beforeHidden && !popup('slash') && !popup('mention') && editors.every(item => item.getText().endsWith('@Synthetic')));
      if (count > 1) {
        gates[1].setEditor(editors[1]); await open(editors[1], 'mention');
        const incoming = popup('mention'); editor.destroy();
        check('retiring another editor preserves the current popup', popup('mention') === incoming);
      }
      editors.forEach(item => { if (!item.isDestroyed) item.destroy(); });
      check('destroy releases all owned gates and portals', activeSubscriptions === 0 && subscriptions === releases && !popup('slash') && !popup('mention'));
      groups.push({ editors: count, cyclesPerMenu: 100, itemBuilds, subscriptions, releases, maxSubscriptions, remainingSubscriptions: activeSubscriptions, checks });
    } finally { editors.forEach(item => { if (!item.isDestroyed) item.destroy(); }); roots.forEach(root => root.remove()); }
  }
  return { groups, asyncCreation: await runAsyncCreation(), template: await runTemplateMenu(), scope: 'Real Tiptap plugins and DOM in active isolated Chromium; synthetic actions, no native input or performance budget inferred.' };
}

async function runAsyncCreation() {
  const cases = [];
  for (const action of ['complete', 'link-mark', 'hidden-return', 'blur', 'selection', 'query', 'query-undo', 'same-text-replacement', 'appended-replacement', 'readonly-return', 'destroy', 'escape', 'cancel'] as const) {
    const root = document.createElement('div'); document.body.appendChild(root);
    const gate = new EditorSuggestionGate(); let complete!: (value: { id: string; name: string } | null) => void; let creations = 0;
    const editor = new Editor({ element: root, extensions: [StarterKit.configure({ link: false }), EntityLink.configure({ autoDetectEnabled: false }), EntityMentionSuggestion.configure({ gate, getEntities: () => [], onCreateElement: () => { creations++; return new Promise(resolve => { complete = resolve; }); } })], content: initial });
    try {
      if (action === 'appended-replacement') editor.registerPlugin(new Plugin({
        appendTransaction(transactions, _oldState, state) {
          if (!transactions.some(transaction => transaction.getMeta('synthetic-replace-trigger'))) return null;
          const end = state.selection.from; return state.tr.insertText('New', end - 3, end);
        },
      }));
      gate.setEditor(editor); await open(editor, 'mention', 'New');
      const create = popup('mention')!.querySelector<HTMLButtonElement>('button')!;
      create.click(); create.click(); ensure(creations === 1 && !popup('mention'), 'Create invocation must be claimed once');
      if (action === 'link-mark') editor.view.dispatch(editor.state.tr.addMark(editor.state.selection.from - 3, editor.state.selection.from, editor.schema.marks.entityLink.create({ targetKind: 'element', targetId: 'synthetic-created' })).setMeta('addToHistory', false));
      if (action === 'hidden-return') { gate.setEditor(null); gate.setEditor(editor); }
      if (action === 'blur') editor.view.dom.blur();
      if (action === 'selection') editor.commands.setTextSelection(2);
      if (action === 'query') editor.commands.insertContent('changed');
      if (action === 'appended-replacement') editor.view.dispatch(editor.state.tr.setMeta('synthetic-replace-trigger', true));
      if (action === 'same-text-replacement') { const end = editor.state.selection.from; editor.view.dispatch(editor.state.tr.insertText('New', end - 3, end)); }
      if (action === 'query-undo') { const position = editor.state.selection.from; editor.commands.insertContent('x'); editor.commands.deleteRange({ from: position, to: position + 1 }); }
      if (action === 'readonly-return') { editor.setEditable(false); editor.setEditable(true); }
      if (action === 'escape') editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      const before = JSON.stringify(editor.getJSON());
      if (action === 'destroy') editor.destroy();
      complete(action === 'cancel' ? null : { id: 'synthetic-created', name: 'New' }); await settle();
      if (action === 'complete' || action === 'link-mark') ensure(editor.getText() === 'Synthetic prose. New ' && JSON.stringify(editor.getJSON()).includes('synthetic-created'), `${action}: expected live marked insertion`);
      else if (action === 'cancel') ensure(editor.getText() === 'Synthetic prose. ', 'Current canceled creation must preserve existing cleanup behavior');
      else ensure(JSON.stringify(editor.getJSON()) === before, `${action}: late creation wrote through an invalid context`);
      cases.push({ action, creations, passed: true });
    } finally { if (!editor.isDestroyed) editor.destroy(); root.remove(); }
  }
  return cases;
}

async function runTemplateMenu() {
  const root = document.createElement('div'); document.body.appendChild(root);
  const editor = new Editor({ element: root, extensions: [StarterKit, createDefaultSlashMenu()], content: initial });
  try {
    await open(editor, 'slash'); const stale = firstAction('slash')!;
    editor.view.dom.blur(); await settle(); const before = JSON.stringify(editor.getJSON()); stale.click();
    ensure(!popup('slash') && JSON.stringify(editor.getJSON()) === before, 'Ungated template menu retained stale actions');
    return { blurClosesAndRejectsStaleActions: true };
  } finally { editor.destroy(); root.remove(); }
}
