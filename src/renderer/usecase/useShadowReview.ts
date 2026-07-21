import { useCallback, useMemo } from 'react';
import { v7 as uuidv7 } from 'uuid';
import type { Comment } from '../domain/comment';
import type { ChapterWritingStatus } from '../domain/book-node';
import { initDatabase, getDb } from '../lib/db';
import { createCommentRepository } from '../sqlite-repo/comment-repo';
import { createBookNodeSqliteRepository } from '../sqlite-repo/node-repo';
import { useDataStore } from '../store/data-store';
import { syncCommentCreate, syncCommentDelete, syncNodeUpdate } from './sync-helpers';

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
 * tested without mounting React. Store publication and sync enqueueing are
 * deliberately below the awaited transaction: a rollback or commit failure
 * cannot leak a partially applied review outside SQLite.
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

  const replaced = await getDb().transaction(async (tx) => {
    const commentRepo = createCommentRepository(projectId, tx);
    const nodeRepo = createBookNodeSqliteRepository(projectId, tx);
    const stale = (await commentRepo.findAll()).filter(
      (comment) =>
        comment.source === 'shadow' &&
        comment.targetKind === 'node' &&
        comment.targetId === chapterId,
    );

    for (const comment of stale) await commentRepo.delete(comment.id);
    for (const comment of comments) await commentRepo.create(comment);

    const updated = await nodeRepo.update(chapterId, {
      writingStatus: status,
      updatedAt: now,
    });
    if (!updated || updated.projectId !== projectId || updated.kind !== 'chapter') {
      throw new Error(`Shadow review chapter ${chapterId} disappeared`);
    }
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

  // The sync outbox mirrors the already-committed local transaction. These
  // calls are intentionally after commit, so a rolled-back review never
  // leaks partial remote mutations.
  for (const comment of replaced) syncCommentDelete(comment.id, projectId);
  for (const comment of comments) {
    syncCommentCreate(comment.id, projectId, commentSyncPayload(comment));
  }
  syncNodeUpdate(chapterId, projectId, { writingStatus: status });

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
