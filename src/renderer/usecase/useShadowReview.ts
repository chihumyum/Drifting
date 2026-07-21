import { useCallback, useMemo } from 'react';
import { v7 as uuidv7 } from 'uuid';
import type { Comment } from '../domain/comment';
import type { ChapterWritingStatus } from '../domain/book-node';
import { initDatabase } from '../lib/db';
import { createCommentRepository } from '../sqlite-repo/comment-repo';
import { createBookNodeSqliteRepository } from '../sqlite-repo/node-repo';
import { useDataStore } from '../store/data-store';
import { withAtomicSyncTransaction } from './sync-helpers';

export interface ShadowReviewCommentInput {
  bodyJson: string;
  targetBlockId?: string | null;
  targetBlockIds?: string[];
  anchorJson: string;
  metadataJson?: string | null;
}

export interface UseShadowReviewContext {
  projectId: string;
  userId: string;
}

export interface CommitShadowReviewInput extends UseShadowReviewContext {
  chapterId: string;
  status: Extract<ChapterWritingStatus, 'draft' | 'finished'>;
  comments: ShadowReviewCommentInput[];
}

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

/**
 * Commits one Shadow review as a single local database mutation.
 *
 * The previous pipeline deleted old comments, inserted findings one by one,
 * and only then updated the chapter status. A cancellation or persistence
 * failure between those calls could leave an empty/partial review. Keeping the
 * replacement and decision in one SQLite transaction makes the old review or
 * the complete new review visible, never an in-between state.
 *
 * This is exported separately from the hook so the failure boundary can be
 * tested without mounting React. The replacement, decision, and durable sync
 * outbox rows share one transaction; store publication happens only after it
 * commits.
 */
export async function commitShadowReview({
  projectId,
  userId,
  chapterId,
  status,
  comments: inputs,
}: CommitShadowReviewInput): Promise<{ comments: Comment[]; replacedCommentIds: string[] }> {
  if (!projectId) throw new Error('commitShadowReview requires a projectId');
  if (!userId) throw new Error('commitShadowReview requires a userId');
  await initDatabase(userId);

  const state = useDataStore.getState();
  const chapter = state.bookNodes.find(
    (node) => node.id === chapterId && node.projectId === projectId,
  );
  if (!chapter || chapter.kind !== 'chapter') {
    throw new Error(`Shadow review chapter ${chapterId} was not found in project ${projectId}`);
  }

  const now = new Date().toISOString();
  const comments: Comment[] = inputs.map((input) => ({
    id: uuidv7(),
    projectId,
    kind: 'note',
    targetKind: 'node',
    targetId: chapterId,
    targetBlockId: input.targetBlockId ?? null,
    anchorJson: input.anchorJson,
    authorKind: 'ai',
    authorId: null,
    authorName: 'Shadow',
    bodyJson: input.bodyJson,
    status: 'open',
    priority: null,
    source: 'shadow',
    metadataJson: input.metadataJson ?? null,
    targetBlockIdsJson: JSON.stringify(input.targetBlockIds ?? []),
    resolvedAt: null,
    createdAt: now,
    updatedAt: now,
  }));

  const replaced = await withAtomicSyncTransaction(projectId, async (tx, sync) => {
    const commentRepo = createCommentRepository(projectId, tx);
    const nodeRepo = createBookNodeSqliteRepository(projectId, tx);
    const stale = (await commentRepo.findAll()).filter(
      (comment) =>
        comment.source === 'shadow' &&
        comment.targetKind === 'node' &&
        comment.targetId === chapterId,
    );

    for (const comment of stale) {
      await commentRepo.delete(comment.id);
      await sync('comment', 'delete', comment.id, projectId);
    }
    for (const comment of comments) {
      await commentRepo.create(comment);
      await sync('comment', 'create', comment.id, projectId, commentSyncPayload(comment));
    }

    const updated = await nodeRepo.update(chapterId, {
      writingStatus: status,
      updatedAt: now,
    });
    if (!updated || updated.projectId !== projectId || updated.kind !== 'chapter') {
      throw new Error(`Shadow review chapter ${chapterId} disappeared`);
    }
    await sync('node', 'update', chapterId, projectId, { writingStatus: status });
    return stale;
  });

  // Publish the comments + decision in one Zustand update, and only while the
  // reviewed project is still mounted. The SQLite commit and outbox remain
  // valid if the user switched projects while the review was finishing, but a
  // stale completion must not contaminate the newly hydrated project's store.
  useDataStore.setState((current) => {
    const mountedChapter = current.bookNodes.some(
      (node) => node.id === chapterId && node.projectId === projectId && node.kind === 'chapter',
    );
    if (!mountedChapter) return current;
    return {
      comments: [
        ...current.comments.filter(
          (comment) =>
            !(
              comment.projectId === projectId &&
              comment.source === 'shadow' &&
              comment.targetKind === 'node' &&
              comment.targetId === chapterId
            ),
        ),
        ...comments,
      ],
      bookNodes: current.bookNodes.map((node) =>
        node.id === chapterId && node.projectId === projectId && node.kind === 'chapter'
          ? { ...node, writingStatus: status, updatedAt: now }
          : node,
      ),
    };
  });

  return {
    comments,
    replacedCommentIds: replaced.map((comment) => comment.id),
  };
}

export function useShadowReview({ projectId, userId }: UseShadowReviewContext) {
  if (!projectId) throw new Error('useShadowReview requires a projectId');
  if (!userId) throw new Error('useShadowReview requires a userId');

  const commit = useCallback(
    (
      chapterId: string,
      status: Extract<ChapterWritingStatus, 'draft' | 'finished'>,
      comments: ShadowReviewCommentInput[],
    ) => commitShadowReview({ projectId, userId, chapterId, status, comments }),
    [projectId, userId],
  );

  return useMemo(() => ({ commitShadowReview: commit }), [commit]);
}
