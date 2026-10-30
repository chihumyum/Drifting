// Readers' comments reach the library here (docs/share-links.md). The owner's
// device imports each one as an ordinary comment under the service's comment
// id, so two devices importing it at once write the same row and the journal
// carries it to every other device. The service stops offering a comment once
// one device acknowledges it, so a comment deleted here is not imported again.
import { inArray } from 'drizzle-orm';
import { createPlainCommentDoc, type Comment } from '../../domain/comment';
import { getDb } from '../../lib/db';
import { events } from '../../lib/events';
import { CommentTable, ProjectTable } from '../../schema/drizzle';
import { createCommentRepository } from '../../sqlite-repo/comment-repo';
import { deleteEntityRelationsInTransaction } from '../../usecase/entity-relation-cleanup';
import { withAtomicSyncTransaction } from '../../usecase/sync-helpers';
import { shareLinkApi, type ShareInbox, type ShareInboxComment } from './share-link-api';
import { useShareLinkStore } from './share-link-store';
import type { ShareCommentMetadata } from './share-comment';

/** How old the cached link list may be before an inbox pass reloads it. */
const SHARE_LIST_MAX_AGE_MS = 5 * 60_000;

export interface ShareInboxResult {
  imported: number;
  withdrawn: number;
  statusesReported: number;
  /** Comments this pass wrote into the library, for the author's notification. */
  arrived: ShareInboxComment[];
}


export function inboxCommentToComment(remote: ShareInboxComment, now: string): Comment {
  const { anchor } = remote;
  return {
    id: remote.id,
    projectId: remote.projectId,
    kind: 'note',
    targetKind: remote.entityKind,
    targetId: remote.entityId,
    targetBlockId: anchor.targetBlockId,
    anchorJson: JSON.stringify({
      selectedText: anchor.selectedText,
      createdAt: remote.createdAt,
      blockText: anchor.blockText,
      blockSelectionFrom: anchor.blockSelectionFrom,
      blockSelectionTo: anchor.blockSelectionTo,
      blockSnapshots: anchor.blockSnapshots,
      ...(anchor.textAnchor ? { textAnchor: anchor.textAnchor } : {}),
    }),
    authorKind: 'external',
    authorId: null,
    authorName: remote.authorName,
    bodyJson: createPlainCommentDoc(remote.body),
    status: remote.status === 'resolved' ? 'resolved' : 'open',
    priority: null,
    source: 'api',
    metadataJson: JSON.stringify({ shareLink: { shareId: remote.shareId } } satisfies ShareCommentMetadata),
    targetBlockIdsJson: JSON.stringify(anchor.targetBlockIds),
    resolvedAt: remote.status === 'resolved' ? now : null,
    createdAt: remote.createdAt,
    updatedAt: now,
  };
}

/** The journal payload of a comment create, as usecase/useComment writes it. */
function commentSyncPayload(comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    kind: comment.kind,
    targetKind: comment.targetKind,
    targetId: comment.targetId,
    targetBlockId: comment.targetBlockId,
    anchorJson: comment.anchorJson,
    authorKind: comment.authorKind,
    authorId: comment.authorId,
    authorName: comment.authorName,
    bodyJson: comment.bodyJson,
    status: comment.status,
    priority: comment.priority,
    source: comment.source,
    metadataJson: comment.metadataJson,
    targetBlockIdsJson: comment.targetBlockIdsJson,
    resolvedAt: comment.resolvedAt,
  };
}

const byProject = <T extends { projectId: string }>(items: readonly T[]) => {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(item.projectId, [...(groups.get(item.projectId) ?? []), item]);
  return groups;
};

async function localStatuses(ids: readonly string[]): Promise<Map<string, Comment['status']>> {
  const result = new Map<string, Comment['status']>();
  for (let index = 0; index < ids.length; index += 500) {
    const rows = await getDb().select({ id: CommentTable.id, status: CommentTable.status }).from(CommentTable)
      .where(inArray(CommentTable.id, ids.slice(index, index + 500)));
    for (const row of rows) result.set(row.id, row.status as Comment['status']);
  }
  return result;
}

/** Applies one inbox read to the local library and reports what was applied. */
export async function applyShareInbox(inbox: ShareInbox): Promise<ShareInboxResult> {
  const projectIds = [...new Set([...inbox.comments, ...inbox.withdrawals, ...inbox.imported].map(item => item.projectId))];
  const local = new Set(projectIds.length
    ? (await getDb().select({ id: ProjectTable.id }).from(ProjectTable).where(inArray(ProjectTable.id, projectIds))).map(row => row.id)
    : []);
  const existing = await localStatuses([...inbox.comments, ...inbox.withdrawals].map(item => item.id));
  const imported: string[] = [];
  const withdrawn: string[] = [];
  const arrived: ShareInboxComment[] = [];
  const changed = new Set<string>();
  const now = new Date().toISOString();

  for (const [projectId, comments] of byProject(inbox.comments)) {
    // A project this device has not restored yet is left for a device that has it.
    if (!local.has(projectId)) continue;
    const incoming = comments.filter(comment => !existing.has(comment.id));
    const fresh = incoming.map(comment => inboxCommentToComment(comment, now));
    if (fresh.length) {
      await withAtomicSyncTransaction(projectId, async (tx, sync) => {
        const repository = createCommentRepository(projectId, tx);
        for (const comment of fresh) {
          await repository.create(comment);
          await sync('comment', 'create', comment.id, projectId, commentSyncPayload(comment));
        }
      });
      changed.add(projectId);
      arrived.push(...incoming);
    }
    imported.push(...comments.map(comment => comment.id));
  }

  for (const [projectId, items] of byProject(inbox.withdrawals)) {
    if (!local.has(projectId)) continue;
    const present = items.filter(item => existing.has(item.id));
    if (present.length) {
      await withAtomicSyncTransaction(projectId, async (tx, sync) => {
        const repository = createCommentRepository(projectId, tx);
        for (const item of present) {
          await deleteEntityRelationsInTransaction(tx, sync, projectId, 'comment', item.id);
          await repository.delete(item.id);
          await sync('comment', 'delete', item.id, projectId);
        }
      });
      changed.add(projectId);
    }
    withdrawn.push(...items.map(item => item.id));
  }

  if (imported.length || withdrawn.length) await shareLinkApi.acknowledge(imported, withdrawn);

  // Readers see the status the owner gives the comment on any device.
  const reported = inbox.imported.filter(item => local.has(item.projectId));
  const statuses = await localStatuses(reported.map(item => item.id));
  const updates = reported.flatMap(item => {
    const status = statuses.get(item.id);
    if (!status) return [];
    const visible = status === 'open' ? 'open' : 'resolved';
    return visible === item.status ? [] : [{ id: item.id, status: visible } as const];
  });
  if (updates.length) await shareLinkApi.setStatuses(updates);

  for (const projectId of changed) events.emit('sync:project-changed', { projectId, projectionImpact: 'workspace' });
  return { imported: imported.length, withdrawn: withdrawn.length, statusesReported: updates.length, arrived };
}

/** One inbox pass. Accounts without share links make no inbox request. */
export async function syncShareInbox(signal?: AbortSignal): Promise<ShareInboxResult | null> {
  const shares = await useShareLinkStore.getState().refresh(SHARE_LIST_MAX_AGE_MS);
  if (!shares.length) return null;
  signal?.throwIfAborted();
  return applyShareInbox(await shareLinkApi.inbox(signal));
}
