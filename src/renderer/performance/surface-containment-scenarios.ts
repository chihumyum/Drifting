import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import * as Y from 'yjs';
import { editorSurfaceContentVisibility } from '../features/editor/surface-rendering';

/** Shared production rendering policy with real Tiptap/Yjs and browser layout. */
export async function runSurfaceContainmentScenarios() {
  const checks: string[] = [];
  const check = (name: string, value: unknown) => { if (!value) throw new Error(`Surface containment: ${name}`); checks.push(name); };
  const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const viewport = document.createElement('div');
  viewport.style.cssText = 'position:relative;width:700px;height:320px'; document.body.append(viewport);
  const surfaces = Array.from({ length: 3 }, (_, index) => {
    const surface = document.createElement('div'); surface.style.cssText = 'position:absolute;inset:0;overflow:auto';
    const element = document.createElement('div'); surface.append(element); viewport.append(surface);
    const doc = new Y.Doc();
    const editor = new Editor({ element, extensions: [StarterKit.configure({ undoRedo: false }), Collaboration.configure({ document: doc })] });
    editor.commands.setContent({ type: 'doc', content: Array.from({ length: 50 }, () => ({ type: 'paragraph', content: [{ type: 'text', text: '合成写作正文。'.repeat(140) }] })) });
    return { index, surface, doc, editor, dom: editor.view.dom };
  });
  const show = (index: number, visible: boolean, preparing = false) => {
    surfaces[index]!.surface.style.visibility = visible ? 'visible' : 'hidden';
    surfaces[index]!.surface.style.contentVisibility = editorSurfaceContentVisibility(visible, preparing);
  };
  try {
    check('browser supports content visibility', CSS.supports('content-visibility', 'hidden'));
    show(0, true); show(1, false); show(2, false); await frame();
    check('dormant editor DOM remains connected but is skipped by rendering', surfaces.every(s => s.dom.isConnected) && surfaces[0]!.dom.checkVisibility() && !surfaces[1]!.dom.checkVisibility());
    const background = surfaces[1]!;
    const paragraph = background.doc.getXmlFragment('default').get(0) as Y.XmlElement;
    background.doc.transact(() => (paragraph.get(0) as Y.XmlText).insert(0, 'background update '), 'remote');
    check('hidden document still accepts canonical background updates', background.editor.getText().startsWith('background update '));
    show(1, false, true); await frame();
    check('preparing editor has layout before it is revealed', getComputedStyle(background.surface).contentVisibility === 'visible' && background.dom.getBoundingClientRect().height > 0 && getComputedStyle(background.surface).visibility === 'hidden');
    show(0, false); show(1, true); background.editor.commands.focus('end'); await frame();
    check('revealed editor receives DOM focus', document.activeElement === background.dom && background.dom.checkVisibility());
    const before = background.editor.getText(); background.editor.commands.insertContent(' authored');
    check('retained Yjs undo removes the new edit', background.editor.commands.undo() && background.editor.getText() === before);
    check('retained Yjs redo restores the new edit', background.editor.commands.redo() && background.editor.getText() === before + ' authored');
    const anchor = background.editor.state.selection.anchor; background.surface.scrollTop = 100;
    show(1, false); show(0, true); await frame(); show(0, false); show(1, false, true); await frame(); show(1, true); await frame();
    check('return preserves editor identity selection and scroll', background.editor.view.dom === background.dom && background.editor.state.selection.anchor === anchor && background.surface.scrollTop === 100);
    for (let cycle = 0; cycle < 20; cycle++) { show(1, false); show(2, true); show(2, false); show(1, false, true); await frame(); show(1, true); }
    check('repeated reveals preserve canonical content', background.editor.getText() === before + ' authored');
    return { checks, documents: 3, cycles: 20, scope: 'Production containment policy, real Tiptap/Yjs, Chromium layout/focus/undo. Native WebKit and IME are separate acceptance.' };
  } finally { for (const s of surfaces) { s.editor.destroy(); s.doc.destroy(); } viewport.remove(); }
}
