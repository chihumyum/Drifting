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

import { proseDocId, type ProseEntityType } from '../yjs-doc-id';
import { getLiveYDoc } from '../yjs-doc-registry';
import { useDataStore } from '../../store/data-store';
import { useAgentEditStore } from '../../store/agent-edit-store';
import { useSettingsStore } from '../../store/settings-store';
import { createYjsRepository } from '../../sqlite-repo/yjs-repo';
import { createBookContentRepository } from '../../sqlite-repo/content-repo';
import { countWordsInPmJson } from '../word-count';
import { computeBlockChanges, type AgentBlockChange } from './block-diff';
import { detectEntityLinkSpans } from '../extensions/entity-link';
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

/**
 * Re-derive entityLink marks on the given just-edited blocks. The agent writes
 * blocks as PLAIN text, so without this an edit silently strips the inline
 * @-mention marks the inline-mention projection — and where_does_entity_appear /
 * get_node_context — read. Mirrors the editor's auto-detect (same registered
 * targets), idempotent (re-formatting the same span is a no-op). Must run INSIDE
 * the agent transaction so the marks land with the edit. Each touched block is
 * plain text at this point (just written), so positions align with the string.
 */
function relinkBlockMentions(frag: Y.XmlFragment, blockIds: string[]): void {
  for (const blockId of blockIds) {
    const idx = blockIndexInFrag(frag, blockId);
    if (idx < 0) continue;
    const el = frag.toArray()[idx];
    if (!(el instanceof Y.XmlElement)) continue;
    for (const child of el.toArray()) {
      if (!(child instanceof Y.XmlText)) continue;
      const text = child.toString();
      for (const span of detectEntityLinkSpans(text)) {
        child.format(span.from, span.to - span.from, { entityLink: span.attrs });
      }
    }
  }
}

function newParagraph(text: string): Y.XmlElement {
  const el = new Y.XmlElement('paragraph');
  el.setAttribute('id', uuidv7());
  if (text) el.insert(0, [new Y.XmlText(text)]);
  return el;
}

/** Like {@link newParagraph} but keeps a SPECIFIC block id — used when reverting
 *  a deletion, so the restored block carries its ORIGINAL uuid (the edit store,
 *  activity spots and comment anchors are all keyed on it) instead of a fresh one
 *  that would orphan every reference to the block. */
function newParagraphWithId(blockId: string, text: string): Y.XmlElement {
  const el = new Y.XmlElement('paragraph');
  el.setAttribute('id', blockId);
  if (text) el.insert(0, [new Y.XmlText(text)]);
  return el;
}

/** Re-insert a single block with a KNOWN id after `afterBlockId` (or at the top
 *  when null). Used only to undo a deletion — preserves the original block id. */
export function yInsertBlockWithId(
  frag: Y.XmlFragment,
  afterBlockId: string | null,
  blockId: string,
  text: string,
): void {
  let at = 0;
  if (afterBlockId) {
    const i = blockIndexInFrag(frag, afterBlockId);
    if (i < 0) throw new Error(`after block "${afterBlockId}" not found`);
    at = i + 1;
  }
  frag.insert(at, [newParagraphWithId(blockId, text)]);
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
): Promise<{ contentJson: string; blockIds: string[]; changes: AgentBlockChange[] }> {
  const { yDocToProsemirrorJSON } = await import('y-prosemirror');
  const toJson = (doc: Y.Doc) => JSON.stringify(yDocToProsemirrorJSON(doc, 'default'));

  const live = getLiveYDoc(docId);
  if (live) {
    // Mutate the open editor's doc — it updates the page live and the editor's
    // own update/sync handlers persist + push it. Snapshot before/after so the
    // change indicators (#4) can diff exactly which blocks moved.
    const beforeJson = toJson(live);
    let blockIds: string[] = [];
    live.transact(() => {
      const frag = live.getXmlFragment('default');
      blockIds = yMutate(frag);
      relinkBlockMentions(frag, blockIds); // re-derive @-mention marks on plain agent text
    }, AGENT_ORIGIN);
    const contentJson = toJson(live);
    return { contentJson, blockIds, changes: computeBlockChanges(beforeJson, contentJson) };
  }

  const yrepo = createYjsRepository();
  if (await yrepo.hasDocState(docId)) {
    const doc = new Y.Doc();
    try {
      const snap = await yrepo.getSnapshot(docId);
      if (snap) Y.applyUpdate(doc, snap.stateBlob, 'load');
      for (const u of await yrepo.listUpdates(docId)) Y.applyUpdate(doc, u.updateBlob, 'load');
      const beforeJson = toJson(doc);

      // Collect the diff this edit produces so we can append it for sync.
      const diff: Uint8Array[] = [];
      const onUpdate = (u: Uint8Array, origin: unknown) => {
        if (origin === AGENT_ORIGIN) diff.push(new Uint8Array(u));
      };
      doc.on('update', onUpdate);
      let blockIds: string[] = [];
      doc.transact(() => {
        const frag = doc.getXmlFragment('default');
        blockIds = yMutate(frag);
        relinkBlockMentions(frag, blockIds); // re-derive @-mention marks on plain agent text
      }, AGENT_ORIGIN);
      doc.off('update', onUpdate);

      for (const u of diff) await yrepo.appendUpdate(docId, u);
      await yrepo.upsertSnapshot(docId, Y.encodeStateAsUpdate(doc));
      const contentJson = toJson(doc);
      return { contentJson, blockIds, changes: computeBlockChanges(beforeJson, contentJson) };
    } finally {
      doc.destroy();
    }
  }

  // No Yjs state yet — edit the contentJson the editor will seed Yjs from. The
  // JSON path can't surface stable block uuids from Yjs, but serialize.ts keeps
  // them, so block changes are still diffable.
  const beforeJson = await readFallbackJson();
  const contentJson = jsonMutate(beforeJson);
  return { contentJson, blockIds: [], changes: computeBlockChanges(beforeJson, contentJson) };
}

/** The per-entity contentJson projection cache (the seed the editor reads on an
 *  empty doc). The node body lives in a SQLite row; element/storyline/category
 *  bodies are on the in-memory data store. Returns null when absent. */
async function readBodyFromStore(entityType: ProseEntityType, id: string): Promise<string | null> {
  switch (entityType) {
    case 'node':
      return (await createBookContentRepository().findByNodeId(id))?.contentJson ?? null;
    case 'element':
      return useDataStore.getState().bookElements.find((e) => e.id === id)?.contentJson ?? null;
    case 'storyline':
      return useDataStore.getState().storylines.find((s) => s.id === id)?.contentJson ?? null;
    case 'category':
      return useDataStore.getState().bookElementCategories.find((c) => c.id === id)?.contentJson ?? null;
  }
}

/**
 * Any prose entity's CURRENT body as contentJson, read from the Yjs truth so the
 * agent sees exactly what the editor shows. Falls back to the supplied
 * `fallbackContentJson` (when the caller already has it) and then the projection
 * cache, when the entity has no Yjs state yet.
 */
export async function getEntityContentJson(
  entityType: ProseEntityType,
  id: string,
  fallbackContentJson?: string | null,
): Promise<string> {
  return readProseContentJson(
    proseDocId(entityType, id),
    async () => fallbackContentJson ?? (await readBodyFromStore(entityType, id)) ?? '{}',
  );
}

/** Chapter (node) read — thin shim over {@link getEntityContentJson}. */
export async function getChapterContentJson(
  nodeId: string,
  fallbackContentJson: string | null,
): Promise<string> {
  return getEntityContentJson('node', nodeId, fallbackContentJson);
}

/**
 * Refresh the materialized contentJson cache (and, for chapters, the word count)
 * after a write, so every other reader stays consistent. Each entity type
 * persists through its own usecase — note updateStoryline takes an OBJECT arg
 * `{id, contentJson}`, unlike the others' `(id, updates)`.
 */
async function persistBody(
  ctx: AgentToolContext,
  entityType: ProseEntityType,
  id: string,
  contentJson: string,
): Promise<void> {
  switch (entityType) {
    case 'node':
      await ctx.write.updateContentByNodeId(id, { contentJson });
      await ctx.write.updateNode(id, { wordCount: countWordsInPmJson(contentJson) });
      return;
    case 'element':
      await ctx.write.updateElement(id, { contentJson });
      return;
    case 'storyline':
      await ctx.write.updateStoryline({ id, contentJson });
      return;
    case 'category':
      await ctx.write.updateCategory(id, { contentJson });
      return;
  }
}

/**
 * Apply a prose edit to ANY prose entity through its Yjs document, keeping the
 * contentJson cache in sync (chapters also keep wordCount) and seeding the
 * prose-edit review state. See {@link writeProseDoc}. This is the ONE place the
 * heterogeneous per-entity cache dispatch + the edit-store record() live.
 */
export async function writeEntityProse(
  ctx: AgentToolContext,
  entityType: ProseEntityType,
  id: string,
  yMutate: (frag: Y.XmlFragment) => string[],
  jsonMutate: (currentJson: string) => string,
): Promise<{ contentJson: string; blockIds: string[]; changes: AgentBlockChange[] }> {
  const { contentJson, blockIds, changes } = await writeProseDoc(
    proseDocId(entityType, id),
    yMutate,
    jsonMutate,
    async () => (await readBodyFromStore(entityType, id)) ?? '{}',
  );

  await persistBody(ctx, entityType, id, contentJson);

  // Seed the prose-edit review state synchronously — before the tool result
  // round-trips back to the agent — so the colored ticks / reveal animation /
  // approve cards are ready the instant the edit lands (#3/#4).
  if (changes.length) {
    useAgentEditStore
      .getState()
      .record(entityType, id, changes, useSettingsStore.getState().agentEditMode);
  }

  return { contentJson, blockIds, changes };
}

/**
 * Apply a prose edit to a chapter — thin shim over {@link writeEntityProse}.
 */
export async function writeChapterProse(
  ctx: AgentToolContext,
  nodeId: string,
  yMutate: (frag: Y.XmlFragment) => string[],
  jsonMutate: (currentJson: string) => string,
): Promise<{ contentJson: string; blockIds: string[]; changes: AgentBlockChange[] }> {
  return writeEntityProse(ctx, 'node', nodeId, yMutate, jsonMutate);
}

/** The element's CURRENT body as contentJson — thin shim over
 *  {@link getEntityContentJson}. */
export async function getElementContentJson(elementId: string): Promise<string> {
  return getEntityContentJson('element', elementId);
}

/**
 * Apply a body edit to an element — thin shim over {@link writeEntityProse}.
 * Routing through the generic path means element edits now RECORD into the
 * review store (reveal / approve / ticks) like every other prose entity, instead
 * of silently auto-applying.
 */
export async function writeElementProse(
  ctx: AgentToolContext,
  elementId: string,
  yMutate: (frag: Y.XmlFragment) => string[],
  jsonMutate: (currentJson: string) => string,
): Promise<{ contentJson: string; blockIds: string[]; changes: AgentBlockChange[] }> {
  return writeEntityProse(ctx, 'element', elementId, yMutate, jsonMutate);
}

/**
 * Undo a single agent block change on any prose entity (approve-mode "reject").
 * Applies the inverse edit through the Yjs doc with a NON-agent origin, so it
 * persists + syncs like an ordinary user edit and does NOT re-record into the
 * edit store:
 *   - changed → restore the block's old text
 *   - new     → remove the block
 *   - deleted → re-insert the old text after its anchor, preserving the ORIGINAL
 *               block id so the restored block stays tracked (not a fresh uuid)
 * Live doc when the entity is open in an editor (the usual case while reviewing);
 * else a transient doc rehydrated from SQLite.
 */
const REVERT_ORIGIN = 'agent-revert';
export async function revertEntityBlock(
  entityType: ProseEntityType,
  id: string,
  change: AgentBlockChange,
): Promise<void> {
  const docId = proseDocId(entityType, id);
  const mutate = (frag: Y.XmlFragment) => {
    if (change.op === 'changed') {
      yReplaceBlockText(frag, { blockId: change.blockId }, change.oldText);
    } else if (change.op === 'new') {
      yRemoveBlocks(frag, [change.blockId]);
    } else {
      // Restore the deleted block under its old anchor, keeping its original id.
      yInsertBlockWithId(frag, change.afterPrevId, change.blockId, change.oldText);
    }
  };

  const live = getLiveYDoc(docId);
  if (live) {
    // The live editor's own update/sync handlers persist + push it.
    live.transact(() => mutate(live.getXmlFragment('default')), REVERT_ORIGIN);
    return;
  }

  const yrepo = createYjsRepository();
  if (await yrepo.hasDocState(docId)) {
    const doc = new Y.Doc();
    try {
      const snap = await yrepo.getSnapshot(docId);
      if (snap) Y.applyUpdate(doc, snap.stateBlob, 'load');
      for (const u of await yrepo.listUpdates(docId)) Y.applyUpdate(doc, u.updateBlob, 'load');
      const diff: Uint8Array[] = [];
      const onUpdate = (u: Uint8Array, origin: unknown) => {
        if (origin === REVERT_ORIGIN) diff.push(new Uint8Array(u));
      };
      doc.on('update', onUpdate);
      doc.transact(() => mutate(doc.getXmlFragment('default')), REVERT_ORIGIN);
      doc.off('update', onUpdate);
      for (const u of diff) await yrepo.appendUpdate(docId, u);
      await yrepo.upsertSnapshot(docId, Y.encodeStateAsUpdate(doc));
    } finally {
      doc.destroy();
    }
  }
}
