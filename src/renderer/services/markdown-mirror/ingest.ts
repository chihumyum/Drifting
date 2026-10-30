/**
 * Merges an authored file edited outside Drifting back into Yjs
 * (docs/markdown-mirror.md).
 *
 * The file is a peer that last synced at the ledger's base state. Its edit is
 * planned against that base on a fork, so the resulting update names the
 * characters the author actually saw, then merges into the current document
 * like any concurrent edit. Yjs, the chapter's fields, the sync journal and
 * the ledger commit in one transaction: a crash can never leave the edit
 * applied but the file still looking unread, which would apply it twice.
 */
import { deriveProseMetricFromJson } from '@drifting/prose-metrics';
import { and, eq, isNull } from 'drizzle-orm';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import * as Y from 'yjs';

import {
  CHAPTER_WRITING_STATUSES,
  DRIFT_STATUSES,
  type BookNodeKind,
  type WritingStatus,
} from '../../domain/book-node';
import { computeBlockChanges, type AgentBlockChange } from '../../lib/agent/block-diff';
import { relinkBlockMentions } from '../../lib/agent/chapter-prose';
import { agentAuthoredJournal } from '../../lib/agent/runtime/agent-authored-journal';
import { planWorkspaceProseFileBlocks } from '../../lib/agent/runtime/workspace-prose-file';
import {
  createYjsProseBlock,
  snapshotYjsProseBlocks,
  type YjsProseBlock,
} from '../../lib/agent/runtime/yjs-prose-command';
import { getDb } from '../../lib/db';
import { extractOutline, serializeOutline } from '../../lib/outline';
import { getActiveEditor } from '../../lib/active-editor';
import { getLiveYDoc } from '../../lib/yjs-doc-registry';
import { proseDocId } from '../../lib/yjs-doc-id';
import { createPersistedYjsUpdateOrigin } from '../../lib/yjs-persistence-origin';
import { BookNodeTable } from '../../schema/drizzle';
import { createBookContentRepository } from '../../sqlite-repo/content-repo';
import { createMarkdownMirrorRepository, type MarkdownMirrorFileRow } from '../../sqlite-repo/markdown-mirror-repo';
import { createYjsRepository } from '../../sqlite-repo/yjs-repo';
import { useDataStore } from '../../store/data-store';
import { useAgentEditStore } from '../../store/agent-edit-store';
import { externalRevealMask, planExternalEdits, presentExternalEdits } from '../../lib/external-edit-presentation';
import { appendAuthoredDomainMutation } from '../../sync/journal/domain-mutation';
import { appendYjsUpdateMutation } from '../../sync/journal/yjs-update';
import { registerAuthoredYjsMaterialization } from '../../sync/journal/yjs-materialization';
import { captureSnapshotHistory } from '../snapshot-history.service';
import { flushOpenYjsDocument } from '../yjs-local-durability.service';
import { parseAuthoredFile, type AuthoredFields } from './authored-file';
import { diffText, reconcileProseBlocks } from './reconcile-yjs';

const FILE_ORIGIN = 'markdown-mirror:file';
const MERGE_ORIGIN = 'markdown-mirror:merge';
/** A file that removes more than this share of a long body is snapshotted first. */
const LARGE_DELETION_SHARE = 0.5;
const LARGE_DELETION_CHARACTERS = 200;

/** Ledger fields stored next to the base state. */
export interface MirrorBaseFields extends AuthoredFields {
  extra: string;
}

export function parseBaseFields(json: string): MirrorBaseFields {
  const value = JSON.parse(json) as Partial<MirrorBaseFields>;
  return {
    status: (value.status ?? 'draft') as WritingStatus,
    summary: value.summary ?? '',
    extra: value.extra ?? '',
  };
}

export type MirrorIngestResult =
  | { kind: 'unchanged' }
  | {
      kind: 'merged';
      /**
       * Paragraphs where the file and Drifting changed the same spot since the
       * file was written, with their merged text.
       */
      overlapped: { blockId: string; text: string }[];
      /** Paragraphs the file edited after Drifting deleted them, restored. */
      restored: string[];
      /** What the merge changed in Drifting's current prose, for the unread presentation. */
      changes: AgentBlockChange[];
    }
  | { kind: 'deferred' }
  | {
      kind: 'skipped';
      reason: 'frontmatter' | 'identity' | 'empty' | 'lineage' | 'missing' | 'unconfirmed';
    };

export interface MirrorIngestInput {
  projectId: string;
  nodeId: string;
  row: MarkdownMirrorFileRow;
  text: string;
  sha256: string;
}

class LineageError extends Error {}

const normalizeSummary = (value: string) => value.replace(/\s+$/u, '');

function plainLength(blocks: readonly YjsProseBlock[]): number {
  let length = 0;
  const visit = (nodes: YjsProseBlock['content']) => {
    for (const node of nodes ?? []) {
      if (node.kind === 'text') length += node.text.length;
      else visit(node.content);
    }
  };
  for (const block of blocks) visit(block.content);
  return length;
}

/** Every client the base saw is at least as far along in the current state. */
function descendsFrom(base: Uint8Array, current: Uint8Array): boolean {
  const known = Y.decodeStateVector(current);
  for (const [client, clock] of Y.decodeStateVector(base)) {
    if ((known.get(client) ?? 0) < clock) return false;
  }
  return true;
}

function blockText(block: YjsProseBlock): string {
  const visit = (nodes: YjsProseBlock['content']): string =>
    (nodes ?? []).map((node) => (node.kind === 'text' ? node.text : `\n${visit(node.content)}`)).join('');
  return visit(block.content);
}

/** Base-text spans each side changed; an insertion is an empty span at its spot. */
function changedSpans(base: string, next: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let at = 0;
  for (const edit of diffText(base, next)) {
    const length = Array.from(edit.text).length;
    if (edit.kind === 'insert') spans.push([at, at]);
    else {
      if (edit.kind === 'delete') spans.push([at, at + length]);
      at += length;
    }
  }
  return spans;
}

/** Both sides changed the same or touching characters of one paragraph. */
function editsCollide(base: string, mine: string, theirs: string): boolean {
  const ours = changedSpans(base, mine);
  return changedSpans(base, theirs).some(([start, end]) =>
    ours.some(([otherStart, otherEnd]) => start <= otherEnd && otherStart <= end));
}

function validStatus(kind: BookNodeKind, status: WritingStatus | undefined): WritingStatus | undefined {
  if (!status) return undefined;
  const allowed: readonly WritingStatus[] = kind === 'chapter' ? CHAPTER_WRITING_STATUSES : DRIFT_STATUSES;
  return allowed.includes(status) ? status : undefined;
}

export async function ingestAuthoredFile(input: MirrorIngestInput): Promise<MirrorIngestResult> {
  const { projectId, nodeId, row } = input;
  if (!row.fileSha256) return { kind: 'skipped', reason: 'unconfirmed' };
  const parsed = parseAuthoredFile(input.text);
  if (!parsed.ok) return { kind: 'skipped', reason: 'frontmatter' };
  if (parsed.id && parsed.id !== nodeId) return { kind: 'skipped', reason: 'identity' };
  if (getActiveEditor()?.view.composing) return { kind: 'deferred' };

  const docId = proseDocId('node', nodeId);
  const baseFields = parseBaseFields(row.baseFieldsJson);
  const working = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(working, row.baseState, 'markdown-mirror:base');
    const baseBlocks = snapshotYjsProseBlocks(working);
    const desired = await planWorkspaceProseFileBlocks({
      blocks: baseBlocks,
      content: parsed.body,
      idempotencyKey: `markdown-mirror:${docId}:${input.sha256}`,
      matchRendered: true,
    });
    if (plainLength(desired) === 0 && plainLength(baseBlocks) > 0) {
      return { kind: 'skipped', reason: 'empty' };
    }

    // The file's edit, expressed against the state its author saw.
    const updates: Uint8Array[] = [];
    const capture = (update: Uint8Array, origin: unknown) => {
      if (origin === FILE_ORIGIN) updates.push(update);
    };
    working.on('update', capture);
    let touched: string[] = [];
    working.transact(() => {
      touched = reconcileProseBlocks(working.getXmlFragment('default'), desired);
    }, FILE_ORIGIN);
    if (touched.length > 0) {
      working.transact(() => {
        relinkBlockMentions(working.getXmlFragment('default'), touched, projectId, docId);
      }, FILE_ORIGIN);
    }
    working.off('update', capture);
    const forward = updates.length === 0 ? null : updates.length === 1 ? updates[0]! : Y.mergeUpdates(updates);
    const forkState = Y.encodeStateAsUpdate(working);

    const fileStatus = parsed.fields.status;
    const fileSummary = parsed.fields.summary;
    const statusChanged = fileStatus !== undefined && fileStatus !== baseFields.status;
    const summaryChanged =
      fileSummary !== undefined && normalizeSummary(fileSummary) !== normalizeSummary(baseFields.summary);
    const nextFields: MirrorBaseFields = {
      status: statusChanged ? fileStatus! : baseFields.status,
      summary: summaryChanged ? normalizeSummary(fileSummary!) : baseFields.summary,
      extra: parsed.extra,
    };
    const ledger = {
      path: row.path,
      fileSha256: input.sha256,
      baseState: forkState,
      baseFieldsJson: JSON.stringify(nextFields),
    };

    if (!forward && !statusChanged && !summaryChanged) {
      await createMarkdownMirrorRepository().record(projectId, docId, row.directory, ledger);
      return { kind: 'unchanged' };
    }

    if (getLiveYDoc(docId)) await flushOpenYjsDocument(docId);
    const removed = plainLength(baseBlocks) - plainLength(desired);
    if (forward && removed > Math.max(LARGE_DELETION_CHARACTERS, plainLength(baseBlocks) * LARGE_DELETION_SHARE)) {
      // A large removal stays recoverable in the history before it lands.
      const before = new Y.Doc({ gc: false });
      try {
        if (await loadPersisted(createYjsRepository(), docId, before)) {
          await captureSnapshotHistory(docId, Y.encodeStateAsUpdate(before), 'periodic');
        }
      } finally {
        before.destroy();
      }
    }

    const committedAt = new Date().toISOString();
    let merged: Uint8Array | null = null;
    let updateId = 0;
    const overlapped: { blockId: string; text: string }[] = [];
    const restored: string[] = [];
    let blockChanges: AgentBlockChange[] = [];
    let projected: typeof BookNodeTable.$inferSelect | undefined;
    try {
      await getDb().transaction(async (tx) => {
        const nodes = await tx
          .select()
          .from(BookNodeTable)
          .where(and(eq(BookNodeTable.id, nodeId), eq(BookNodeTable.projectId, projectId), isNull(BookNodeTable.deletedAt)))
          .limit(1);
        const node = nodes[0];
        if (!node) throw new MissingNodeError();
        const changes = agentAuthoredJournal.createChangeSet();
        const nodeUpdate: Partial<typeof BookNodeTable.$inferInsert> = {};
        const syncPayload: Record<string, unknown> = {};
        const status = statusChanged ? validStatus(node.kind as BookNodeKind, fileStatus) : undefined;
        if (status && status !== node.writingStatus) {
          nodeUpdate.writingStatus = status;
          syncPayload.writingStatus = status;
        }
        if (summaryChanged && nextFields.summary !== node.summary) {
          nodeUpdate.summary = nextFields.summary;
          syncPayload.summary = nextFields.summary;
        }

        if (forward) {
          const repo = createYjsRepository(tx);
          const current = new Y.Doc({ gc: false });
          try {
            const seeded = !(await loadPersisted(repo, docId, current));
            // A never-opened body was rendered from its seed: adopt it with the edit.
            if (seeded) Y.applyUpdate(current, row.baseState, 'markdown-mirror:seed');
            // The base must be history this document has seen. After a restore
            // or reset it is not, and the edit's anchors would never resolve.
            if (!descendsFrom(Y.encodeStateVectorFromUpdate(row.baseState), Y.encodeStateVector(current))) {
              throw new LineageError();
            }
            if (Y.decodeStateVector(Y.encodeStateVector(current)).has(working.clientID)) {
              throw new RetryError();
            }
            const mine = new Map(snapshotYjsProseBlocks(current).map((block) => [block.id, blockText(block)]));
            const baseById = new Map(baseBlocks.map((block) => [block.id, blockText(block)]));
            const theirs = new Map(desired.map((block) => [block.id, blockText(block)]));
            const collided = touched.filter((id) => {
              const base = baseById.get(id);
              const ours = mine.get(id);
              const file = theirs.get(id);
              return base !== undefined && ours !== undefined && file !== undefined && editsCollide(base, ours, file);
            });

            const parts: Uint8Array[] = seeded ? [row.baseState, forward] : [forward];
            const beforeJson = JSON.stringify(yDocToProsemirrorJSON(current, 'default'));
            Y.applyUpdate(current, forward, FILE_ORIGIN);
            // Text the file added to a paragraph Drifting deleted meanwhile
            // would vanish with it: put the file's paragraph back.
            const present = new Set(snapshotYjsProseBlocks(current).map((block) => block.id));
            const repairs: Uint8Array[] = [];
            const repair = (update: Uint8Array) => repairs.push(update);
            current.on('update', repair);
            current.transact(() => {
              const fragment = current.getXmlFragment('default');
              desired.forEach((block, index) => {
                if (present.has(block.id) || !touched.includes(block.id)) return;
                let at = 0;
                for (let previous = index - 1; previous >= 0; previous -= 1) {
                  const anchor = desired[previous]!.id;
                  const found = fragment.toArray().findIndex(
                    (child) => child instanceof Y.XmlElement && child.getAttribute('id') === anchor,
                  );
                  if (found >= 0) {
                    at = found + 1;
                    break;
                  }
                }
                fragment.insert(at, [createYjsProseBlock(block)]);
                present.add(block.id);
                restored.push(block.id);
              });
            }, MERGE_ORIGIN);
            current.off('update', repair);
            parts.push(...repairs);
            const mergedText = new Map(snapshotYjsProseBlocks(current).map((block) => [block.id, blockText(block)]));
            for (const id of collided) {
              const text = mergedText.get(id);
              if (text !== undefined) overlapped.push({ blockId: id, text });
            }
            merged = parts.length === 1 ? parts[0]! : Y.mergeUpdates(parts);

            const mutationIndex = appendYjsUpdateMutation(changes, docId, merged);
            const appended = await repo.appendMaterializedUpdate(
              docId,
              merged,
              { kind: 'authored', builder: changes, mutationIndex },
              { kind: 'file' },
            );
            updateId = appended.updateId;
            await repo.upsertSnapshot(docId, Y.encodeStateAsUpdate(current), { advanceRevision: false });
            registerAuthoredYjsMaterialization(tx, changes, mutationIndex, appended.token);

            const contentJson = JSON.stringify(yDocToProsemirrorJSON(current, 'default'));
            blockChanges = computeBlockChanges(beforeJson, contentJson);
            const content = await createBookContentRepository(tx).updateByNodeId(nodeId, {
              contentJson,
              outlineJson: serializeOutline(extractOutline(contentJson)),
              updatedAt: committedAt,
            });
            if (!content) throw new MissingNodeError();
            const metric = await deriveProseMetricFromJson(contentJson);
            Object.assign(nodeUpdate, {
              wordCount: metric.wordCount,
              wordCountBasisKind: 'yjs',
              wordCountBasisHash: metric.basisHash,
              wordCountBasisRevision: appended.revision,
              wordCountBasisServerSeq: null,
            });
          } finally {
            current.destroy();
          }
        }

        if (Object.keys(nodeUpdate).length > 0) {
          const rows = await tx
            .update(BookNodeTable)
            .set({ ...nodeUpdate, updatedAt: committedAt })
            .where(and(eq(BookNodeTable.id, nodeId), eq(BookNodeTable.projectId, projectId)))
            .returning();
          projected = rows[0];
        }
        if (Object.keys(syncPayload).length > 0) {
          appendAuthoredDomainMutation(changes, {
            entityType: 'node',
            mutationType: 'update',
            entityId: nodeId,
            projectId,
            payload: syncPayload,
          });
        }
        await createMarkdownMirrorRepository(tx).record(projectId, docId, row.directory, ledger);
        if (forward || Object.keys(syncPayload).length > 0) {
          await agentAuthoredJournal.record(tx, { projectId, changes, committedAt });
        }
      });
    } catch (error) {
      if (error instanceof LineageError) return { kind: 'skipped', reason: 'lineage' };
      if (error instanceof MissingNodeError) return { kind: 'skipped', reason: 'missing' };
      if (error instanceof RetryError) return { kind: 'deferred' };
      throw error;
    }

    // The changed paragraphs show in blue, like an Agent edit. An open editor
    // masks them before the merge lands, so the reveal never shows the end first.
    const plan = planExternalEdits('node', nodeId, blockChanges);
    const live = getLiveYDoc(docId);
    const guard = `markdown-mirror:${docId}:${updateId}`;
    const masked = live && merged ? externalRevealMask(plan) : [];
    if (masked.length > 0) useAgentEditStore.getState().stageAutoRevealGuard('node', nodeId, guard, masked);
    try {
      if (live && merged) {
        Y.applyUpdate(live, merged, createPersistedYjsUpdateOrigin(updateId, guard));
      }
      presentExternalEdits('node', nodeId, plan);
    } finally {
      if (masked.length > 0) useAgentEditStore.getState().clearAutoRevealGuard(guard);
    }
    if (projected) {
      const node = projected;
      useDataStore.setState((state) => ({
        bookNodes: state.bookNodes.map((item) =>
          item.id === nodeId && item.projectId === projectId
            ? {
                ...item,
                summary: node.summary,
                writingStatus: node.writingStatus as typeof item.writingStatus,
                wordCount: node.wordCount,
                wordCountBasisKind: node.wordCountBasisKind as typeof item.wordCountBasisKind,
                wordCountBasisHash: node.wordCountBasisHash,
                wordCountBasisRevision: node.wordCountBasisRevision,
                wordCountBasisServerSeq: node.wordCountBasisServerSeq,
                updatedAt: node.updatedAt,
              }
            : item,
        ) as typeof state.bookNodes,
      }));
    }
    return { kind: 'merged', overlapped, restored, changes: blockChanges };
  } finally {
    working.destroy();
  }
}

class MissingNodeError extends Error {}
/** The fork drew a client id the document already uses; the next scan retries. */
class RetryError extends Error {}

/** Loads the persisted Yjs state into `doc`; false when the body has none yet. */
async function loadPersisted(
  repo: ReturnType<typeof createYjsRepository>,
  docId: string,
  doc: Y.Doc,
): Promise<boolean> {
  const snapshot = await repo.getSnapshot(docId);
  if (snapshot) Y.applyUpdate(doc, snapshot.stateBlob, 'load');
  const updates = await repo.listUpdates(docId);
  for (const update of updates) Y.applyUpdate(doc, update.updateBlob, 'load');
  return Boolean(snapshot) || updates.length > 0;
}
