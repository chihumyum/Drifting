/**
 * Agent prose writes that go through the editor's Yjs document — the editor's
 * actual source of truth — instead of only the `contentJson` cache.
 *
 * Why this exists: a chapter's prose lives in a Yjs CRDT (yjs_snapshots +
 * yjs_updates). `node_content.contentJson` is a *materialized projection* the
 * editor reads only to seed an empty doc. The agent used to write contentJson
 * directly, so its edits never reached the Y.Doc: they "persisted" in SQLite but
 * the editor kept rendering the old Y.Doc, and opening the chapter could even
 * overwrite the agent's edit when the editor re-derived contentJson from its
 * stale Y.Doc. (Reported bug #7.)
 *
 * The fix: apply edits to the Y.Doc.
 *   - chapter open in an editor  → mutate the live Y.Doc (registry) so the page
 *     updates instantly and the editor's own handlers persist + sync it.
 *   - chapter closed, has Yjs    → rehydrate a transient Y.Doc from SQLite,
 *     apply, persist the diff + a snapshot so the next open shows it.
 *   - never opened (no Yjs yet)   → write contentJson; the editor seeds Yjs from
 *     it on first open (with its own pull-first protection).
 * In every case the contentJson cache + wordCount are refreshed so read_node
 * / search_prose / the dashboard stay consistent.
 *
 * Edits are applied IN PLACE on the Y.XmlFragment (only the touched blocks
 * change), which preserves the ids, marks and inline mentions of every other
 * block without needing a schema round-trip.
 */
import * as Y from 'yjs';
import { v7 as uuidv7 } from 'uuid';

import { makeDocId } from '../yjs-doc-id';
import { getLiveYDoc } from '../yjs-doc-registry';
import { useDataStore } from '../../store/data-store';
import { createYjsRepository } from '../../sqlite-repo/yjs-repo';
import { createBookContentRepository } from '../../sqlite-repo/content-repo';
import { countWordsInPmJson } from '../word-count';
import type { AgentToolContext } from './tool-handlers';

// Update origin: anything other than 'load'/'remote'/'seed'/'restore' is treated
// as a local edit by useYjsDoc (→ appended to yjs_updates) and useYjsSync (→
// pushed to the server), so live-doc edits persist + sync without extra work.
const AGENT_ORIGIN = 'agent';

// ---- in-place Y.XmlFragment mutators ---------------------------------------

function blockIndexInFrag(frag: Y.XmlFragment, blockId: string): number {
  const arr = frag.toArray();
  for (let i = 0; i < arr.length; i++) {
    const el = arr[i];
    if (el instanceof Y.XmlElement && el.getAttribute('id') === blockId) return i;
  }
  return -1;
}

function setBlockText(el: Y.XmlElement, text: string): void {
  if (el.length > 0) el.delete(0, el.length);
  if (text) el.insert(0, [new Y.XmlText(text)]);
}

function newParagraph(text: string): Y.XmlElement {
  const el = new Y.XmlElement('paragraph');
  el.setAttribute('id', uuidv7());
  if (text) el.insert(0, [new Y.XmlText(text)]);
  return el;
}

/**
 * Replace one block's text in place (by uuid blockId or 1-based number).
 * Returns the block's stable uuid — the agent-change tracker keys on it (#17).
 */
export function yReplaceBlockText(
  frag: Y.XmlFragment,
  target: { block?: number; blockId?: string },
  text: string,
): string {
  let idx: number;
  if (target.blockId) {
    idx = blockIndexInFrag(frag, target.blockId);
    if (idx < 0) throw new Error(`Block "${target.blockId}" not found in this node`);
  } else {
    const n = target.block ?? 0;
    idx = n - 1;
    if (idx < 0 || idx >= frag.length) {
      throw new Error(`Block #${n} out of range (1..${frag.length})`);
    }
  }
  const el = frag.toArray()[idx];
  if (!(el instanceof Y.XmlElement)) throw new Error('Target block is not an element');
  setBlockText(el, text);
  return el.getAttribute('id') ?? '';
}

export function yRemoveBlocks(frag: Y.XmlFragment, blockIds: string[]): void {
  const indices = [
    ...new Set(
      blockIds.map((id) => {
        const i = blockIndexInFrag(frag, id);
        if (i < 0) throw new Error(`Block "${id}" not found`);
        return i;
      }),
    ),
  ].sort((a, b) => b - a); // delete from the end so earlier indices stay valid
  for (const i of indices) frag.delete(i, 1);
}

/** Replace a block range with fresh paragraphs; returns the new blocks' uuids. */
export function yReplaceBlockRange(
  frag: Y.XmlFragment,
  fromBlockId: string,
  toBlockId: string,
  texts: string[],
): string[] {
  const fi = blockIndexInFrag(frag, fromBlockId);
  const ti = blockIndexInFrag(frag, toBlockId);
  if (fi < 0) throw new Error(`from block "${fromBlockId}" not found`);
  if (ti < 0) throw new Error(`to block "${toBlockId}" not found`);
  if (fi > ti) throw new Error('fromBlockId must be at or before toBlockId in the chapter');
  frag.delete(fi, ti - fi + 1);
  const paras = texts.map(newParagraph);
  frag.insert(fi, paras);
  return paras.map((p) => p.getAttribute('id') ?? '');
}

/** Insert fresh paragraphs; returns the new blocks' uuids. */
export function yInsertBlocks(
  frag: Y.XmlFragment,
  afterBlockId: string | null,
  texts: string[],
): string[] {
  let at = 0;
  if (afterBlockId) {
    const i = blockIndexInFrag(frag, afterBlockId);
    if (i < 0) throw new Error(`after block "${afterBlockId}" not found`);
    at = i + 1;
  }
  const paras = texts.map(newParagraph);
  frag.insert(at, paras);
  return paras.map((p) => p.getAttribute('id') ?? '');
}

/** Append one paragraph; returns its new uuid. */
export function yAppendParagraph(frag: Y.XmlFragment, text: string): string {
  const para = newParagraph(text);
  frag.insert(frag.length, [para]);
  return para.getAttribute('id') ?? '';
}

/**
 * Replace the ENTIRE body with a fresh set of paragraphs (whole-doc rewrite).
 * Returns the new blocks' uuids.
 */
export function yReplaceAllParagraphs(frag: Y.XmlFragment, texts: string[]): string[] {
  if (frag.length > 0) frag.delete(0, frag.length);
  // Always leave at least one (possibly empty) paragraph so the editor schema
  // stays valid — an empty doc with zero blocks can break the bound editor.
  const paras = (texts.length > 0 ? texts : ['']).map(newParagraph);
  frag.insert(0, paras);
  return paras.map((p) => p.getAttribute('id') ?? '');
}

// ---- read / write through the truth representation -------------------------
//
// Both chapters (docId `node-content:<id>`) and elements (`element:<id>`) store
// their body as a Yjs doc with a `contentJson` projection cache. The core
// read/write below is entity-agnostic — it talks only in docIds and a
// fallback-json reader; the chapter/element wrappers add the right docId and
// cache-refresh (chapters also keep wordCount in sync).

/**
 * Read a Yjs-backed body as a contentJson string, from the live editor doc when
 * one is open, else a transient doc rehydrated from SQLite, else the supplied
 * fallback (the projection cache) when the entity has no Yjs state yet.
 */
async function readProseContentJson(
  docId: string,
  readFallbackJson: () => Promise<string>,
): Promise<string> {
  const { yDocToProsemirrorJSON } = await import('y-prosemirror');

  const live = getLiveYDoc(docId);
  if (live && live.getXmlFragment('default').length > 0) {
    return JSON.stringify(yDocToProsemirrorJSON(live, 'default'));
  }

  const repo = createYjsRepository();
  if (await repo.hasDocState(docId)) {
    const doc = new Y.Doc();
    try {
      const snap = await repo.getSnapshot(docId);
      if (snap) Y.applyUpdate(doc, snap.stateBlob, 'load');
      for (const u of await repo.listUpdates(docId)) Y.applyUpdate(doc, u.updateBlob, 'load');
      return JSON.stringify(yDocToProsemirrorJSON(doc, 'default'));
    } finally {
      doc.destroy();
    }
  }
  return readFallbackJson();
}

/**
 * Apply a body edit through the Yjs document when one exists, returning the
 * resulting contentJson. `yMutate` expresses the edit on the Y.XmlFragment;
 * `jsonMutate` is the equivalent on a contentJson string, used only when the
 * entity has no Yjs state yet (the editor seeds Yjs from contentJson on first
 * open). Does NOT touch the projection cache — callers refresh it.
 */
async function writeProseDoc(
  docId: string,
  yMutate: (frag: Y.XmlFragment) => string[],
  jsonMutate: (currentJson: string) => string,
  readFallbackJson: () => Promise<string>,
): Promise<{ contentJson: string; blockIds: string[] }> {
  const { yDocToProsemirrorJSON } = await import('y-prosemirror');
  const toJson = (doc: Y.Doc) => JSON.stringify(yDocToProsemirrorJSON(doc, 'default'));

  const live = getLiveYDoc(docId);
  if (live) {
    // Mutate the open editor's doc — it updates the page live and the editor's
    // own update/sync handlers persist + push it.
    let blockIds: string[] = [];
    live.transact(() => {
      blockIds = yMutate(live.getXmlFragment('default'));
    }, AGENT_ORIGIN);
    return { contentJson: toJson(live), blockIds };
  }

  const yrepo = createYjsRepository();
  if (await yrepo.hasDocState(docId)) {
    const doc = new Y.Doc();
    try {
      const snap = await yrepo.getSnapshot(docId);
      if (snap) Y.applyUpdate(doc, snap.stateBlob, 'load');
      for (const u of await yrepo.listUpdates(docId)) Y.applyUpdate(doc, u.updateBlob, 'load');

      // Collect the diff this edit produces so we can append it for sync.
      const diff: Uint8Array[] = [];
      const onUpdate = (u: Uint8Array, origin: unknown) => {
        if (origin === AGENT_ORIGIN) diff.push(new Uint8Array(u));
      };
      doc.on('update', onUpdate);
      let blockIds: string[] = [];
      doc.transact(() => {
        blockIds = yMutate(doc.getXmlFragment('default'));
      }, AGENT_ORIGIN);
      doc.off('update', onUpdate);

      for (const u of diff) await yrepo.appendUpdate(docId, u);
      await yrepo.upsertSnapshot(docId, Y.encodeStateAsUpdate(doc));
      return { contentJson: toJson(doc), blockIds };
    } finally {
      doc.destroy();
    }
  }

  // No Yjs state yet — edit the contentJson the editor will seed Yjs from. The
  // JSON path can't surface stable block uuids, so the change is reported with
  // no blockIds (the tracker falls back to a coarse "structural" change).
  return { contentJson: jsonMutate(await readFallbackJson()), blockIds: [] };
}

/**
 * The chapter's CURRENT prose as contentJson, read from the Yjs truth so the
 * agent sees exactly what the editor shows. Falls back to the contentJson cache
 * when the chapter has no Yjs state yet.
 */
export async function getChapterContentJson(
  nodeId: string,
  fallbackContentJson: string | null,
): Promise<string> {
  return readProseContentJson(makeDocId('node-content', nodeId), async () => fallbackContentJson ?? '{}');
}

/**
 * Apply a prose edit to a chapter through its Yjs document, keeping the
 * contentJson cache + wordCount in sync. See {@link writeProseDoc}.
 */
export async function writeChapterProse(
  ctx: AgentToolContext,
  nodeId: string,
  yMutate: (frag: Y.XmlFragment) => string[],
  jsonMutate: (currentJson: string) => string,
): Promise<{ contentJson: string; blockIds: string[] }> {
  const { contentJson, blockIds } = await writeProseDoc(
    makeDocId('node-content', nodeId),
    yMutate,
    jsonMutate,
    async () => (await createBookContentRepository().findByNodeId(nodeId))?.contentJson ?? '{}',
  );

  // Refresh the materialized cache + word count so every other reader stays
  // consistent (the live editor also does this on a debounce; a redundant write
  // of the same value is harmless).
  await ctx.write.updateContentByNodeId(nodeId, { contentJson });
  await ctx.write.updateNode(nodeId, { wordCount: countWordsInPmJson(contentJson) });

  return { contentJson, blockIds };
}

/**
 * The element's CURRENT body as contentJson, read from the Yjs truth (elements
 * have a live editor doc too — see ElementEditorView). Falls back to the
 * element's contentJson cache from the data store when it has no Yjs state yet.
 */
export async function getElementContentJson(elementId: string): Promise<string> {
  return readProseContentJson(makeDocId('element', elementId), async () => {
    const el = useDataStore.getState().bookElements.find((e) => e.id === elementId);
    return el?.contentJson ?? '{}';
  });
}

/**
 * Apply a body edit to an element through its Yjs document, keeping the
 * element's contentJson cache in sync. Mirrors {@link writeChapterProse} but
 * elements carry no wordCount, so only the projection cache is refreshed.
 */
export async function writeElementProse(
  ctx: AgentToolContext,
  elementId: string,
  yMutate: (frag: Y.XmlFragment) => string[],
  jsonMutate: (currentJson: string) => string,
): Promise<{ contentJson: string; blockIds: string[] }> {
  const { contentJson, blockIds } = await writeProseDoc(
    makeDocId('element', elementId),
    yMutate,
    jsonMutate,
    async () => {
      const el = useDataStore.getState().bookElements.find((e) => e.id === elementId);
      return el?.contentJson ?? '{}';
    },
  );

  await ctx.write.updateElement(elementId, { contentJson });

  return { contentJson, blockIds };
}
