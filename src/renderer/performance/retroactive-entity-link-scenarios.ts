import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Editor, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import * as Y from 'yjs';
import { EntityLink, isEntityLinkAutoDetectEnabled, linkEntityInDoc } from '../lib/extensions/entity-link';
import { useRetroactiveEntityLinks } from '../features/editor/useRetroactiveEntityLinks';
import type { EditorSessionSource } from '../features/editor/entity-editor-session';
import type { BookElement } from '../domain/book-element';
import { events } from '../lib/events';
import { createSyntheticWorkspaceProjection } from './fixture';
import { retroactiveLinkWork } from './agent-panel-counters';

const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const paragraphs = 40;
const prose: JSONContent = { type: 'doc', content: Array.from({ length: paragraphs }, (_, i) => ({ type: 'paragraph', content: [{ type: 'text', text: `合成元素的合成段落 ${i}` }] })) };
const created = (projectId: string, id = 'synthetic-created'): BookElement => ({ ...createSyntheticWorkspaceProjection(projectId, 0, 1).bookElements[0], id, name: '合成元素', aliases: [] });
type Owner = EditorSessionSource & { editor: Editor; canonicalReady: boolean; parentElementId?: string };
function Binding(owner: Owner) { useRetroactiveEntityLinks(owner.editor, owner); return null; }
const reset = () => { retroactiveLinkWork.calls = 0; retroactiveLinkWork.textNodes = 0; };
const listeners = () => events.all.get('element:element-created')?.length ?? 0;
const linked = (editor: Editor, id: string) => editor.view.dom.querySelectorAll(`[data-target-id="${id}"]`).length;

// The prior listener's routing and guards, copied from dd049524 useEntityEditor.
// It deliberately has no project guard, so the comparison exposes that defect.
function attachLegacy(editor: Editor, source: EditorSessionSource) {
  const receive = ({ element }: { element: BookElement }) => {
    if (editor.isDestroyed || !isEntityLinkAutoDetectEnabled(editor)) return;
    if (source.sourceKind === 'element' && element.id === source.sourceId) return;
    linkEntityInDoc(editor, { kind: 'element', id: element.id, names: [element.name, ...element.aliases] });
  };
  events.on('element:element-created', receive); return () => events.off('element:element-created', receive);
}

export async function runRetroactiveEntityLinkScenarios() {
  const checks: { id: string; passed: true }[] = [];
  const check = (id: string, condition: boolean) => { if (!condition) throw new Error(`Retroactive links: ${id}`); checks.push({ id, passed: true }); };
  const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host);
  const editors: Editor[] = []; const containers: HTMLElement[] = []; const docs: Y.Doc[] = [];
  const legacyDisposers: (() => void)[] = [];
  const render = (owners: Owner[]) => flushSync(() => root.render(owners.map((owner, key) => createElement(Binding, { ...owner, key }))));
  const make = (enabled = true, ydoc?: Y.Doc) => {
    const element = document.createElement('div'); document.body.appendChild(element); containers.push(element);
    const editor = new Editor({ element, extensions: [StarterKit.configure({ undoRedo: ydoc ? false : undefined }), EntityLink.configure({ autoDetectEnabled: enabled, autoDetectTargets: new Map() }), ...(ydoc ? [Collaboration.configure({ document: ydoc })] : [])], ...(ydoc ? {} : { content: prose }) });
    editors.push(editor); return editor;
  };
  const owner = (editor: Editor, projectId = 'project-b'): Owner => ({ editor, projectId, sourceKind: 'node', sourceId: 'synthetic-source', canonicalReady: true });
  const emit = (projectId: string, id?: string) => events.emit('element:element-created', { element: created(projectId, id) });
  try {
    check('starts-without-global-listeners', listeners() === 0);
    const groups = [];
    for (const count of [1, 5, 20]) {
      const old = Array.from({ length: count }, () => make()); await pause();
      for (const editor of old) legacyDisposers.push(attachLegacy(editor, owner(editor)));
      const legacyListeners = listeners(); reset(); emit('project-a');
      const legacy = { listeners: legacyListeners, ...retroactiveLinkWork, crossProjectLinkedEditors: old.filter(editor => linked(editor, 'synthetic-created') === paragraphs).length };
      check(`${count}:legacy-reproduces-foreign-write`, legacy.calls === count && legacy.textNodes === count * paragraphs && legacy.crossProjectLinkedEditors === count);
      for (const dispose of legacyDisposers.splice(0)) dispose(); for (const editor of old) editor.destroy();

      const current = Array.from({ length: count }, () => make()); await pause();
      for (let i = 1; i < count; i++) current[i].view.dom.parentElement!.style.display = 'none';
      const before = current.map(editor => JSON.stringify(editor.getJSON()));
      render(current.map(editor => owner(editor))); const currentListeners = listeners();
      reset(); emit('project-a'); const foreign = { ...retroactiveLinkWork };
      const unchangedForeignEditors = current.filter((editor, i) => JSON.stringify(editor.getJSON()) === before[i]).length;
      check(`${count}:foreign-event-does-no-work`, foreign.calls === 0 && foreign.textNodes === 0 && unchangedForeignEditors === count && currentListeners === 1);
      reset(); emit('project-b'); const own = { ...retroactiveLinkWork };
      const linkedOwnEditors = current.filter(editor => linked(editor, 'synthetic-created') === paragraphs).length;
      check(`${count}:own-hidden-editors-still-link`, own.calls === count && own.textNodes === count * paragraphs && linkedOwnEditors === count);
      groups.push({ editors: count, paragraphs, legacy, current: { listeners: currentListeners, foreign, own, unchangedForeignEditors, linkedOwnEditors } });
      render([]); for (const editor of current) editor.destroy();
      check(`${count}:owners-detached`, listeners() === 0);
    }
    const self = make(); const parent = make(); const disabled = make(false); const unready = make(); const dead = make(); await pause();
    render([
      { ...owner(self), sourceKind: 'element', sourceId: 'synthetic-created' },
      { ...owner(parent), sourceKind: 'patch', parentElementId: 'synthetic-created' },
      owner(disabled), { ...owner(unready), canonicalReady: false }, owner(dead),
    ]);
    dead.destroy(); reset(); emit('project-b');
    check('excluded-disabled-unready-destroyed-do-not-scan', retroactiveLinkWork.calls === 0);
    check('self-link-excluded', linked(self, 'synthetic-created') === 0);
    check('parent-link-excluded', linked(parent, 'synthetic-created') === 0);
    check('disabled-link-excluded', linked(disabled, 'synthetic-created') === 0);
    check('noncanonical-link-excluded', linked(unready, 'synthetic-created') === 0);
    render([{ ...owner(unready), canonicalReady: true }]); reset(); emit('project-b');
    check('canonical-ready-can-link', retroactiveLinkWork.calls === 1 && linked(unready, 'synthetic-created') === paragraphs);

    const rebound = make(); await pause(); render([owner(rebound, 'project-a')]); render([owner(rebound, 'project-b')]);
    const unchanged = JSON.stringify(rebound.getJSON()); reset(); emit('project-a');
    check('layout-rebind-rejects-old-project', retroactiveLinkWork.calls === 0 && JSON.stringify(rebound.getJSON()) === unchanged);
    emit('project-b'); check('layout-rebind-links-current-project', linked(rebound, 'synthetic-created') === paragraphs);
    render([{ ...owner(rebound), canonicalReady: false }]); reset(); emit('project-b', 'later-created');
    check('retiring-canonical-owner-detaches', listeners() === 0 && retroactiveLinkWork.calls === 0);

    const ydoc = new Y.Doc(); docs.push(ydoc); const visible = make(true, ydoc); const hidden = make(true, ydoc);
    visible.commands.setContent(prose); hidden.view.dom.parentElement!.style.display = 'none'; await pause();
    render([owner(visible), owner(hidden)]); const text = visible.state.doc.textContent; emit('project-b');
    check('shared-yjs-visible-and-hidden-linked', linked(visible, 'synthetic-created') === paragraphs && linked(hidden, 'synthetic-created') === paragraphs);
    check('shared-yjs-prose-and-instances-preserved', visible.state.doc.textContent === text && hidden.state.doc.textContent === text && !visible.isDestroyed && !hidden.isDestroyed);
    const encoded = Y.encodeStateAsUpdate(ydoc); const replay = new Y.Doc(); docs.push(replay); Y.applyUpdate(replay, encoded);
    check('shared-yjs-mark-is-canonical', replay.getXmlFragment('default').toString().includes('synthetic-created'));
    render([]);
    for (let cycle = 0; cycle < 100; cycle++) { render([owner(rebound)]); check(`cycle-${cycle}:single-listener`, listeners() === 1); render([]); }
    reset(); emit('project-b');
    check('repeated-close-leaves-no-listener-or-work', listeners() === 0 && retroactiveLinkWork.calls === 0);
    return { implementation: 'project-routed-canonical-owner', groups, checks, lifecycleCycles: 100, remainingListeners: listeners(),
      limitations: ['Reference listener reproduces the pre-change routing behavior in the same headless build; this is not historical whole-app timing.', 'Same-project canonical editors, including hidden Yjs views, still scan and link their own documents. Full scan and regex work within matching editors is unchanged.', 'No native window, physical input, persistence restart or device budget is measured here.'] };
  } finally {
    render([]); flushSync(() => root.unmount()); for (const dispose of legacyDisposers) dispose();
    for (const editor of editors) if (!editor.isDestroyed) editor.destroy();
    for (const doc of docs) doc.destroy(); for (const element of [...containers, host]) element.remove();
  }
}
