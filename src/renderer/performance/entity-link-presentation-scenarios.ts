import { createElement, useEffect, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import { yUndoPluginKey } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { useEntityLinkConfiguration } from '../features/editor/useEntityLinkConfiguration';
import { EntityLink, entityLinkConfig, EntityLinkDanglingPluginKey, configureEntityLinkAutoDetect, flushPendingAutoDetect, type AutoDetectTarget } from '../lib/extensions/entity-link';
import { buildEntityLinkColorSignature, resolveEntityLinkTargetColor } from '../lib/entity-link-appearance';
import { resolveEntityLinkTargetState } from '../lib/entity-link-target-state';
import { useDataStore } from '../store/data-store';
import { useSettingsStore } from '../store/settings-store';
import { createSyntheticWorkspaceProjection } from './fixture';
import { entityLinkPresentationWork as work } from './agent-panel-counters';

const paragraphs = 100; const updates = 100;
const fixture = () => createSyntheticWorkspaceProjection('synthetic-presentation', 5000, 5000);
const elementId = 'synthetic-element-0';
const content = { type: 'doc', content: Array.from({ length: paragraphs }, () => ({ type: 'paragraph', content: [{ type: 'text', text: '合成链接' + '文'.repeat(96),
  marks: [{ type: 'entityLink', attrs: { targetKind: 'element', targetId: elementId, targetBlockId: null } }] }] })) };
const reset = () => { work.danglingScans = 0; work.textNodes = 0; work.colorScans = 0; };
const read = () => ({ ...work });
type BindingProps = { editor: Editor; needed: boolean; canonicalReady?: boolean; autoDetectEnabled?: boolean; autoDetectTargets: ReadonlyMap<string, AutoDetectTarget>; onRender?(ready: boolean): void };
function Binding({ editor, needed, canonicalReady = true, autoDetectEnabled = false, autoDetectTargets, onRender }: BindingProps) {
  const ready = useEntityLinkConfiguration(editor, { autoDetectTargets, autoDetectEnabled }, { canonicalReady, presentationNeeded: needed });
  onRender?.(ready); return createElement('span', { 'data-link-ready': String(ready) });
}
// Reference wiring from 248ca3cb. It intentionally mixes display invalidations
// and increments a shared version in every editor effect, regardless of visibility.
function Legacy({ editor, autoDetectTargets }: BindingProps) {
  const interactive = useSettingsStore(state => state.entityLinkInteractive);
  const mode = useSettingsStore(state => state.entityLinkColorMode);
  const colors = useSettingsStore(state => state.entityLinkKindColors);
  const trash = useDataStore(state => state.trashedEntityIds);
  const signature = useDataStore(state => buildEntityLinkColorSignature(state, mode, colors));
  useLayoutEffect(() => { configureEntityLinkAutoDetect(editor, { autoDetectTargets, autoDetectEnabled: false }); }, [editor, autoDetectTargets]);
  useEffect(() => {
    entityLinkConfig.interactionEnabled = interactive;
    entityLinkConfig.resolveTargetState = (kind, id) => resolveEntityLinkTargetState(useDataStore.getState(), kind, id);
    entityLinkConfig.resolveTargetColor = (kind, id) => resolveEntityLinkTargetColor(kind, id, useDataStore.getState(), mode, colors);
    entityLinkConfig.targetColorVersion++;
    if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(EntityLinkDanglingPluginKey, true));
  }, [editor, autoDetectTargets, interactive, mode, colors, trash, signature]);
  return null;
}
export async function runEntityLinkPresentationScenarios() {
  const previousData = useDataStore.getState(); const previousSettings = useSettingsStore.getState(); const previousConfig = { ...entityLinkConfig };
  const rootHost = document.createElement('div'); document.body.append(rootHost); const root = createRoot(rootHost);
  const editors: Editor[] = []; const containers: HTMLElement[] = []; const docs: Y.Doc[] = [];
  const checks: { id: string; passed: true }[] = [];
  const check = (id: string, condition: boolean) => { if (!condition) throw new Error(`Link presentation: ${id}`); checks.push({ id, passed: true }); };
  const publish = (patch: Partial<typeof previousData>) => flushSync(() => useDataStore.setState(patch));
  const preferences = (patch: Partial<typeof previousSettings>) => flushSync(() => useSettingsStore.setState(patch));
  const make = (doc?: Y.Doc) => {
    const host = document.createElement('div'); containers.push(host); document.body.append(host);
    const editor = new Editor({ element: host, extensions: [StarterKit.configure({ undoRedo: doc ? false : undefined }), EntityLink.configure({ autoDetectEnabled: false }), ...(doc ? [Collaboration.configure({ document: doc })] : [])], ...(doc ? {} : { content }) });
    editors.push(editor); return editor;
  };
  const mount = (rows: BindingProps[], legacy = false) => flushSync(() => root.render(rows.map((row, key) => createElement(legacy ? Legacy : Binding, { ...row, key }))));
  const empty = () => mount([]);
  const color = (editor: Editor) => editor.view.dom.querySelector<HTMLElement>('.entity-link')?.style.getPropertyValue('--entity-link-color');
  const dead = (editor: Editor) => editor.view.dom.querySelectorAll('.entity-link--trashed').length;
  try {
    const profiles = [];
    for (const count of [1, 5, 20]) {
      const sides = [];
      for (const legacy of [true, false]) {
        publish(fixture()); preferences({ entityLinkColorMode: 'contextual', entityLinkInteractive: true });
        const group = Array.from({ length: count }, () => make()); await new Promise<void>(resolve => setTimeout(resolve, 0));
        for (let i = 1; i < count; i++) group[i].view.dom.parentElement!.style.display = 'none';
        let targets: ReadonlyMap<string, AutoDetectTarget> = new Map();
        const rows = () => group.map((editor, i) => ({ editor, needed: i === 0, autoDetectTargets: targets }));
        mount(rows(), legacy); const before = group.map(editor => JSON.stringify(editor.getJSON()));
        reset();
        for (let i = 0; i < updates; i++) {
          publish({ bookElements: useDataStore.getState().bookElements.map((e, index) => index ? e : { ...e, name: `合成名称${i}` }) });
          targets = new Map([[`合成名称${i}`, { kind: 'element', id: elementId }]]); mount(rows(), legacy);
        }
        const rename = read(); reset(); const version = entityLinkConfig.targetColorVersion;
        for (let i = 0; i < updates; i++) publish({ bookElementCategories: useDataStore.getState().bookElementCategories.map(c => ({ ...c, color: i % 2 ? '#445566' : '#778899' })) });
        const colors = { ...read(), versions: entityLinkConfig.targetColorVersion - version }; reset();
        for (const editor of group) editor.view.dispatch(editor.state.tr.setMeta('synthetic-selection', true));
        const laterTransaction = read(); reset();
        for (let i = 0; i < updates; i++) preferences({ entityLinkInteractive: i % 2 === 1 });
        const interaction = read(); reset();
        publish({ bookElements: useDataStore.getState().bookElements.slice(1), trashedEntityIds: new Set([`element:${elementId}`]) });
        const deletion = read();
        check(`${count}:${legacy ? 'reference' : 'current'}:no-prose-write`, group.every((editor, i) => JSON.stringify(editor.getJSON()) === before[i]));
        check(`${count}:${legacy ? 'reference' : 'current'}:visible-deletion`, dead(group[0]) === paragraphs);
        if (!legacy && count > 1) {
          check(`${count}:hidden-display-deferred`, dead(group[count - 1]) === 0 && color(group[count - 1]) === '#112233');
          reset(); const returning = rows(); returning[count - 1].needed = true;
          mount(returning); const prepared = read();
          check(`${count}:prepared-before-display`, dead(group[count - 1]) === paragraphs && color(group[count - 1]) === '' && prepared.danglingScans === 1 && prepared.colorScans === 1);
        }
        sides.push({ rename, colors, laterTransaction, interaction, deletion });
        empty(); for (const editor of group) editor.destroy();
      }
      const [baseline, current] = sides;
      check(`${count}:rename-is-not-display-work`, current.rename.danglingScans === 0 && current.rename.colorScans === 0);
      check(`${count}:color-only-visible-with-one-version`, current.colors.danglingScans === 0 && current.colors.colorScans === updates && current.colors.versions === updates);
      check(`${count}:interaction-and-later-transaction-do-no-work`, Object.values(current.interaction).every(n => n === 0) && Object.values(current.laterTransaction).every(n => n === 0));
      profiles.push({ editors: count, paragraphs, updates, baseline, current });
    }
    publish(fixture()); preferences({ entityLinkInteractive: true, entityLinkColorMode: 'contextual' });
    const doc = new Y.Doc(); docs.push(doc); const visible = make(doc); visible.commands.setContent(content); const hidden = make(doc);
    hidden.view.dom.parentElement!.style.display = 'none'; await new Promise<void>(resolve => setTimeout(resolve, 0));
    const targets = new Map<string, AutoDetectTarget>(); const readyFrames: boolean[] = [];
    const rows = (needed: boolean, canonicalReady = true): BindingProps[] => [{ editor: visible, needed: true, autoDetectTargets: targets },
      { editor: hidden, needed, canonicalReady, autoDetectTargets: targets, onRender: ready => readyFrames.push(ready) }];
    mount(rows(false)); const originalText = visible.state.doc.textContent;
    const manager = yUndoPluginKey.getState(visible.state)!.undoManager; manager.clear();
    reset(); publish({ bookElements: [], trashedEntityIds: new Set([`element:${elementId}`]) });
    check('yjs:only-visible-deletion-scans', work.danglingScans === 1 && work.colorScans === 1 && dead(hidden) === 0);
    reset(); visible.view.dispatch(visible.state.tr.insertText('作者', 1));
    check('yjs:hidden-update-does-no-batch-display-work', work.colorScans === 0 && work.danglingScans === 0 && hidden.state.doc.textContent === '作者' + originalText);
    const before = JSON.stringify(hidden.getJSON()); readyFrames.length = 0; reset(); mount(rows(true));
    check('yjs:preparing-render-is-not-prematurely-ready', readyFrames[0] === false && readyFrames[readyFrames.length - 1] === true);
    check('yjs:preparation-flushes-once', work.danglingScans === 1 && work.colorScans === 1 && dead(hidden) === paragraphs);
    check('yjs:display-preserves-canonical-document', JSON.stringify(hidden.getJSON()) === before && JSON.stringify(visible.getJSON()) === before && manager.undoStack.length === 1);
    check('yjs:author-undo-still-works', visible.commands.undo() && hidden.state.doc.textContent === originalText);
    const replay = new Y.Doc(); docs.push(replay); Y.applyUpdate(replay, Y.encodeStateAsUpdate(doc));
    check('yjs:independent-replay-keeps-prose-and-marks', replay.getXmlFragment('default').toString() === doc.getXmlFragment('default').toString() && !replay.getXmlFragment('default').toString().includes('--entity-link-color'));
    mount(rows(false)); publish(fixture()); readyFrames.length = 0;
    const dispatch = hidden.view.dispatch; hidden.view.dispatch = () => { throw new Error('Synthetic display failure'); };
    try { mount(rows(true)); check('failed-preparation-stays-unready', readyFrames[readyFrames.length - 1] === false); }
    finally { hidden.view.dispatch = dispatch; }
    mount(rows(false)); mount(rows(true));
    check('failed-preparation-retries-current-state', readyFrames[readyFrames.length - 1] === true && dead(hidden) === 0 && color(hidden) === '#112233');
    mount(rows(true, false)); readyFrames.length = 0; mount(rows(true, true));
    check('canonical-rebind-waits-for-new-layout-owner', readyFrames[0] === false && readyFrames[readyFrames.length - 1] === true);
    const automaticRows = rows(false); automaticRows[1].autoDetectEnabled = true;
    automaticRows[1].autoDetectTargets = new Map([['合成新词', { kind: 'element', id: 'synthetic-element-1' }]]);
    mount(automaticRows); reset();
    hidden.commands.insertContentAt(hidden.state.doc.content.size, { type: 'paragraph', content: [{ type: 'text', text: '合成新词' }] });
    flushPendingAutoDetect(hidden);
    check('hidden-automatic-linking-remains-live', hidden.view.dom.querySelectorAll('[data-target-id="synthetic-element-1"]').length === 1
      && JSON.stringify(hidden.getJSON()) === JSON.stringify(visible.getJSON()));
    check('hidden-automatic-linking-does-not-flush-display', work.danglingScans === 0 && work.colorScans === 0);
    empty(); reset(); publish({ bookElements: [] }); preferences({ entityLinkColorMode: 'kind' });
    check('closed-owners-receive-no-work', Object.values(work).every(n => n === 0));
    for (let cycle = 0; cycle < 100; cycle++) { mount(rows(true)); empty(); }
    reset(); publish(fixture()); preferences({ entityLinkColorMode: 'contextual' });
    check('repeated-teardown-leaves-no-work', Object.values(work).every(n => n === 0));
    check('sessions-retain-editors-and-yjs', !visible.isDestroyed && !hidden.isDestroyed && visible.state.doc.textContent === hidden.state.doc.textContent);
    return { implementation: 'shared-inputs-visible-link-presentation', profiles, checks, lifecycleCycles: 100,
      limitations: ['Reference hook reproduces 248ca3cb invalidation wiring in the same headless build; this is not historical app timing.',
        'Hidden editors defer full color/liveness scans; initial plugin construction and per-mark rendering still run, and document/automatic linking/persistence owners are retained.',
        'Real Tiptap/React and in-process Yjs only; native focus, physical input, SQLite restart, retained heap and fixed-device budgets are not measured.'] };
  } finally {
    empty(); flushSync(() => root.unmount()); for (const editor of editors) if (!editor.isDestroyed) editor.destroy();
    for (const doc of docs) doc.destroy(); for (const host of [...containers, rootHost]) host.remove();
    useDataStore.setState(previousData, true); useSettingsStore.setState(previousSettings, true); Object.assign(entityLinkConfig, previousConfig);
  }
}
