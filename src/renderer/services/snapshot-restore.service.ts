/**
 * Snapshot restore — applies a time-machine capture back onto the entity.
 *
 * Prose restore is COVER semantics through the normal Yjs write paths (a CRDT
 * can't rewind, so we author a forward edit that replaces the body with the
 * snapshot's content): the snapshot blob is hydrated into a scratch doc and
 * its fragment children are CLONED into the target doc inside one transaction.
 *   - live doc (entity open in an editor): the editor's own update handler
 *     persists + syncs the transaction like any user edit
 *   - closed doc with Yjs state: rehydrate → mutate → append diff + snapshot
 *     (the same shape as the agent's closed-doc write path)
 *   - never-opened doc: no Yjs to mutate; the contentJson cache write below
 *     seeds the editor on first open
 * Metadata (title/name/summary/kv…) is written back through the same live
 * usecases agent edits use, so optimistic updates + the sync outbox apply.
 *
 * Before touching anything, the CURRENT state is captured into the history
 * (reason 'restore', interval-exempt) — a restore is always undoable by
 * restoring the auto-captured pre-restore row.
 */
import * as Y from 'yjs';
import loglevel from 'loglevel';
import {
  createEntitySnapshotRepository,
  type EntitySnapshotRow,
} from '../sqlite-repo/entity-snapshot-repo';
import { createYjsRepository } from '../sqlite-repo/yjs-repo';
import { proseDocId, type ProseEntityType } from '../lib/yjs-doc-id';
import { getLiveYDoc } from '../lib/yjs-doc-registry';
import { getActiveAgentToolContext, type AgentToolContext } from '../lib/agent/tool-handlers';
import { useAgentEditStore } from '../store/agent-edit-store';
import { useAgentActivityStore } from '../store/agent-activity-store';
import { countWordsInPmJson } from '../lib/word-count';
import type { WritingStatus } from '../domain/book-node';
import { compactUpdatesAfterSnapshot } from './yjs-sync.service';
import {
  captureSnapshotHistory,
  maybeCaptureSnapshotHistory,
  type SnapshotMeta,
} from './snapshot-history.service';

const log = loglevel.getLogger('snapshot-restore');
log.setLevel(loglevel.levels.WARN);

// Treated as a LOCAL edit by useYjsDoc's update handler (unlike the reserved
// 'restore' origin, which marks server-known state): the replacement ops are
// brand-new and must persist + push like a user edit.
const RESTORE_ORIGIN = 'history-restore';

/** Replace the target fragment's children with deep clones of the source's. */
function replaceFragmentContent(target: Y.XmlFragment, source: Y.XmlFragment): void {
  if (target.length > 0) target.delete(0, target.length);
  const clones = source
    .toArray()
    .map((node) => node.clone() as Y.XmlElement | Y.XmlText);
  if (clones.length > 0) target.insert(0, clones);
}

async function applyProseState(docId: string, stateBlob: Uint8Array): Promise<string> {
  const { yDocToProsemirrorJSON } = await import('y-prosemirror');
  const source = new Y.Doc();
  try {
    Y.applyUpdate(source, stateBlob, 'load');
    const sourceFrag = source.getXmlFragment('default');

    const live = getLiveYDoc(docId);
    if (live) {
      live.transact(() => replaceFragmentContent(live.getXmlFragment('default'), sourceFrag), RESTORE_ORIGIN);
      return JSON.stringify(yDocToProsemirrorJSON(live, 'default'));
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
          if (origin === RESTORE_ORIGIN) diff.push(new Uint8Array(u));
        };
        doc.on('update', onUpdate);
        doc.transact(
          () => replaceFragmentContent(doc.getXmlFragment('default'), sourceFrag),
          RESTORE_ORIGIN,
        );
        doc.off('update', onUpdate);

        for (const u of diff) await yrepo.appendUpdate(docId, u);
        const coveredId = await yrepo.maxUpdateId(docId);
        const fullState = Y.encodeStateAsUpdate(doc);
        await yrepo.upsertSnapshot(docId, fullState);
        maybeCaptureSnapshotHistory(docId, fullState, 'restore');
        await compactUpdatesAfterSnapshot(docId, coveredId, yrepo);
        return JSON.stringify(yDocToProsemirrorJSON(doc, 'default'));
      } finally {
        doc.destroy();
      }
    }

    // Never-opened doc: nothing to mutate — the caller persists the snapshot's
    // contentJson as the seed the editor reads on first open.
    return JSON.stringify(yDocToProsemirrorJSON(source, 'default'));
  } finally {
    source.destroy();
  }
}

/** Capture the CURRENT state as a pre-restore safety row (if any state exists). */
async function captureCurrentState(docId: string): Promise<void> {
  const live = getLiveYDoc(docId);
  if (live) {
    await captureSnapshotHistory(docId, Y.encodeStateAsUpdate(live), 'restore');
    return;
  }
  const yrepo = createYjsRepository();
  if (!(await yrepo.hasDocState(docId))) return;
  const doc = new Y.Doc();
  try {
    const snap = await yrepo.getSnapshot(docId);
    if (snap) Y.applyUpdate(doc, snap.stateBlob, 'load');
    for (const u of await yrepo.listUpdates(docId)) Y.applyUpdate(doc, u.updateBlob, 'load');
    await captureSnapshotHistory(docId, Y.encodeStateAsUpdate(doc), 'restore');
  } finally {
    doc.destroy();
  }
}

async function restoreMetadata(
  ctx: AgentToolContext,
  row: EntitySnapshotRow,
  contentJson: string,
): Promise<void> {
  const meta: SnapshotMeta = row.metaJson ? (JSON.parse(row.metaJson) as SnapshotMeta) : {};
  switch (row.entityKind) {
    case 'node': {
      await ctx.write.updateContentByNodeId(row.entityId, { contentJson });
      await ctx.write.updateNode(row.entityId, {
        wordCount: countWordsInPmJson(contentJson),
        ...(meta.title !== undefined ? { title: meta.title } : {}),
        ...(meta.summary !== undefined ? { summary: meta.summary } : {}),
        ...(meta.writingStatus !== undefined
          ? { writingStatus: meta.writingStatus as WritingStatus }
          : {}),
      });
      return;
    }
    case 'element': {
      const fields = {
        contentJson,
        ...(meta.summary !== undefined ? { summary: meta.summary } : {}),
        ...(meta.groupName !== undefined ? { groupName: meta.groupName } : {}),
        ...(meta.kvJson !== undefined ? { kvJson: meta.kvJson } : {}),
      };
      try {
        await ctx.write.updateElement(row.entityId, {
          ...fields,
          ...(meta.name !== undefined ? { name: meta.name } : {}),
          ...(meta.aliases !== undefined ? { aliases: meta.aliases } : {}),
        });
      } catch (err) {
        // The historical name/aliases may now collide with another element
        // (uniqueness invariant). Keep the current identity, restore the rest.
        log.warn('snapshot restore: name/alias conflict — keeping current name', err);
        await ctx.write.updateElement(row.entityId, fields);
      }
      return;
    }
    case 'storyline': {
      await ctx.write.updateStoryline({
        id: row.entityId,
        contentJson,
        ...(meta.name !== undefined ? { name: meta.name } : {}),
        ...(meta.summary !== undefined ? { summary: meta.summary } : {}),
        ...(meta.kvJson !== undefined ? { kvJson: meta.kvJson } : {}),
      });
      return;
    }
    case 'category': {
      await ctx.write.updateCategory(row.entityId, {
        contentJson,
        ...(meta.name !== undefined ? { name: meta.name } : {}),
        ...(meta.elementTemplateKvJson !== undefined
          ? { elementTemplateKvJson: meta.elementTemplateKvJson }
          : {}),
      });
      return;
    }
  }
}

/**
 * Restore an entity to a history snapshot (prose + metadata). Throws when the
 * snapshot row is gone or no project layout is mounted (no write context).
 */
export async function restoreEntitySnapshot(snapshotId: string): Promise<void> {
  const repo = createEntitySnapshotRepository();
  const row = await repo.getById(snapshotId);
  if (!row) throw new Error('Snapshot does not exist or may have been cleaned up');
  const ctx = getActiveAgentToolContext();
  if (!ctx) throw new Error('No writable project context is available. Restore inside an open project.');

  const docId = proseDocId(row.entityKind, row.entityId);

  // Safety net first: the pre-restore state becomes its own history row.
  await captureCurrentState(docId);

  const contentJson = await applyProseState(docId, row.stateBlob);
  await restoreMetadata(ctx, row, contentJson);

  // Pending agent-review markers referenced the replaced content — clear them
  // (the restore supersedes that review), along with the activity "M" dot.
  useAgentEditStore.getState().clear(row.entityKind, row.entityId);
  useAgentActivityStore.getState().clearTouched(row.entityKind, row.entityId);
}

export type { ProseEntityType };
