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
 * In every case the contentJson cache + wordCount are refreshed so read_chapter
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

/** Replace one block's text in place (by uuid blockId or 1-based number). */
export function yReplaceBlockText(
  frag: Y.XmlFragment,
  target: { block?: number; blockId?: string },
  text: string,
): void {
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

export function yReplaceBlockRange(
  frag: Y.XmlFragment,
  fromBlockId: string,
  toBlockId: string,
  texts: string[],
): void {
  const fi = blockIndexInFrag(frag, fromBlockId);
  const ti = blockIndexInFrag(frag, toBlockId);
  if (fi < 0) throw new Error(`from block "${fromBlockId}" not found`);
  if (ti < 0) throw new Error(`to block "${toBlockId}" not found`);
  if (fi > ti) throw new Error('fromBlockId must be at or before toBlockId in the chapter');
  frag.delete(fi, ti - fi + 1);
  frag.insert(fi, texts.map(newParagraph));
}

export function yInsertBlocks(
  frag: Y.XmlFragment,
  afterBlockId: string | null,
  texts: string[],
): void {
  let at = 0;
  if (afterBlockId) {
    const i = blockIndexInFrag(frag, afterBlockId);
    if (i < 0) throw new Error(`after block "${afterBlockId}" not found`);
    at = i + 1;
  }
  frag.insert(at, texts.map(newParagraph));
}

export function yAppendParagraph(frag: Y.XmlFragment, text: string): void {
  frag.insert(frag.length, [newParagraph(text)]);
}

// ---- read / write through the truth representation -------------------------

/**
 * The chapter's CURRENT prose as a contentJson string, read from the Yjs truth
 * (live editor doc, else a transient doc rehydrated from SQLite) so the agent
 * sees exactly what the editor shows. Falls back to the contentJson cache when
 * the chapter has no Yjs state yet.
 */
export async function getChapterContentJson(
  nodeId: string,
  fallbackContentJson: string | null,
): Promise<string> {
  const docId = makeDocId('node-content', nodeId);
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
  return fallbackContentJson ?? '{}';
}

/**
 * Apply a prose edit to a chapter through its Yjs document when one exists, and
 * keep the contentJson cache + wordCount in sync. `yMutate` expresses the edit
 * on the Y.XmlFragment; `jsonMutate` is the equivalent on a contentJson string,
 * used only when the chapter has no Yjs state yet. Returns the resulting JSON.
 */
export async function writeChapterProse(
  ctx: AgentToolContext,
  nodeId: string,
  yMutate: (frag: Y.XmlFragment) => void,
  jsonMutate: (currentJson: string) => string,
): Promise<{ contentJson: string }> {
  const docId = makeDocId('node-content', nodeId);
  const { yDocToProsemirrorJSON } = await import('y-prosemirror');
  const toJson = (doc: Y.Doc) => JSON.stringify(yDocToProsemirrorJSON(doc, 'default'));

  let contentJson: string;
  const live = getLiveYDoc(docId);

  if (live) {
    // Mutate the open editor's doc — it updates the page live and the editor's
    // own update/sync handlers persist + push it.
    live.transact(() => yMutate(live.getXmlFragment('default')), AGENT_ORIGIN);
    contentJson = toJson(live);
  } else {
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
        doc.transact(() => yMutate(doc.getXmlFragment('default')), AGENT_ORIGIN);
        doc.off('update', onUpdate);

        for (const u of diff) await yrepo.appendUpdate(docId, u);
        await yrepo.upsertSnapshot(docId, Y.encodeStateAsUpdate(doc));
        contentJson = toJson(doc);
      } finally {
        doc.destroy();
      }
    } else {
      // No Yjs state — the editor will seed Yjs from contentJson on first open.
      const current = await createBookContentRepository().findByNodeId(nodeId);
      contentJson = jsonMutate(current?.contentJson ?? '{}');
    }
  }

  // Refresh the materialized cache + word count so every other reader stays
  // consistent (the live editor also does this on a debounce; a redundant write
  // of the same value is harmless).
  await ctx.write.updateContentByNodeId(nodeId, { contentJson });
  await ctx.write.updateNode(nodeId, { wordCount: countWordsInPmJson(contentJson) });

  return { contentJson };
}
