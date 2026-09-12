import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import * as Y from 'yjs';
import { EntityLink, entityLinkConfig } from '../lib/extensions/entity-link';

/** Actual browser DOM/ProseMirror/Yjs checks. These do not simulate native IME. */
export function runEntityLinkScenarios() {
  const editors: Editor[] = [];
  const documents: Y.Doc[] = [];
  const containers: HTMLElement[] = [];
  const checks: { id: string; passed: true }[] = [];
  const previous = { ...entityLinkConfig };
  let color: string | null = '#112233';
  entityLinkConfig.resolveTargetColor = () => color;
  const mark = (targetId: string) => ({ type: 'entityLink', attrs: { targetKind: 'element', targetId, targetBlockId: null } });
  const content = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: '合成正文' }] },
    { type: 'paragraph', content: [{ type: 'text', text: '关联', marks: [mark('initial')] }] },
  ] };
  const check = (id: string, condition: boolean) => {
    if (!condition) throw new Error(`Entity-link browser acceptance failed: ${id}`);
    checks.push({ id, passed: true });
  };
  const colors = (editor: Editor, targetId: string) => [...editor.view.dom.querySelectorAll<HTMLElement>(`[data-target-id="${targetId}"]`)]
    .map((link) => link.style.getPropertyValue('--entity-link-color'));
  const create = (document?: Y.Doc) => {
    const element = window.document.createElement('div');
    window.document.body.appendChild(element);
    containers.push(element);
    const editor = new Editor({
      element,
      extensions: [
        StarterKit.configure({ undoRedo: document ? false : undefined }),
        EntityLink.configure({ autoDetectEnabled: false }),
        ...(document ? [Collaboration.configure({ document })] : []),
      ],
      ...(document ? {} : { content }),
    });
    editors.push(editor);
    return editor;
  };
  try {
    const editor = create();
    check('initial-mark-color', colors(editor, 'initial').join() === color);
    const before = JSON.stringify(editor.getJSON());
    color = '#445566';
    entityLinkConfig.targetColorVersion++;
    editor.view.dispatch(editor.state.tr.setMeta('appearance-test', true));
    check('external-appearance-refresh', colors(editor, 'initial').join() === color);
    check('appearance-does-not-write-prose', JSON.stringify(editor.getJSON()) === before);

    editor.view.dispatch(editor.state.tr.addMark(1, 3, editor.schema.marks.entityLink.create(mark('added').attrs)));
    check('new-mark-uses-current-color', colors(editor, 'added').join() === color);
    editor.commands.undo();
    check('undo-removes-added-mark', colors(editor, 'added').length === 0);
    editor.commands.redo();
    check('redo-restyles-restored-mark', colors(editor, 'added').join() === color);

    editor.view.dispatch(editor.state.tr.removeMark(1, 3, editor.schema.marks.entityLink)
      .addMark(1, 3, editor.schema.marks.entityLink.create(mark('replacement').attrs)));
    check('changed-mark-attrs-replace-dom', colors(editor, 'added').length === 0 && colors(editor, 'replacement').join() === color);
    editor.view.pasteHTML('<p><span data-target-kind="element" data-target-id="pasted">合成粘贴</span></p>');
    check('html-paste-uses-current-color', colors(editor, 'pasted').every((value) => value === color) && colors(editor, 'pasted').length > 0);

    color = null;
    entityLinkConfig.targetColorVersion++;
    editor.view.dispatch(editor.state.tr.setMeta('appearance-test', true));
    check('prose-mode-clears-existing-colors', [...editor.view.dom.querySelectorAll<HTMLElement>('.entity-link')]
      .every((link) => link.style.getPropertyValue('--entity-link-color') === ''));
    color = '#778899';
    entityLinkConfig.targetColorVersion++;
    editor.view.dispatch(editor.state.tr.setMeta('appearance-test', true));
    check('appearance-restores-existing-colors', [...editor.view.dom.querySelectorAll<HTMLElement>('.entity-link')]
      .every((link) => link.style.getPropertyValue('--entity-link-color') === color));

    const localDocument = new Y.Doc();
    const remoteDocument = new Y.Doc();
    documents.push(localDocument, remoteDocument);
    const local = create(localDocument);
    const remote = create(remoteDocument);
    local.commands.setContent(content);
    Y.applyUpdate(remoteDocument, Y.encodeStateAsUpdate(localDocument));
    remote.commands.insertContentAt(1, { type: 'text', text: '远端合成', marks: [mark('remote')] });
    Y.applyUpdate(localDocument, Y.encodeStateAsUpdate(remoteDocument));
    check('remote-yjs-mark-color', colors(local, 'remote').join() === color);
    check('remote-yjs-prose-converges', JSON.stringify(local.getJSON()) === JSON.stringify(remote.getJSON()));
    check('colors-not-persisted-in-mark-attrs', !JSON.stringify(local.getJSON()).includes('--entity-link-color'));
    return checks;
  } finally {
    for (const editor of editors) editor.destroy();
    for (const document of documents) document.destroy();
    for (const container of containers) container.remove();
    Object.assign(entityLinkConfig, previous);
  }
}
