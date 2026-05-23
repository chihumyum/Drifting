import { useCallback, useMemo } from 'react';
import { v7 as uuidv7 } from 'uuid';
import { initDatabase, getDb } from '../lib/db';
import { EntityRelationTable } from '../schema/drizzle';
import { createPlainCommentDoc, extractTextFromCommentBody, getSelectedTextFromAnchor } from '../domain/manuscript-comment';
import type {
  CommentAction,
  CommentAuthorKind,
  CommentPriority,
  CommentSource,
  CommentTargetKind,
  ManuscriptComment,
} from '../domain/manuscript-comment';
import type { Memo } from '../domain/memo';
import { createMemoSqliteRepository } from '../sqlite-repo/memo-repo';
import {
  createCommentActionRepository,
  createManuscriptCommentRepository,
} from '../sqlite-repo/manuscript-comment-repo';
import { useDataStore, type EntityRelationLink } from '../store/data-store';
import { withOptimisticUpdate } from './optimistic';
import {
  syncCommentActionCreate,
  syncEntityRelationCreate,
  syncManuscriptCommentCreate,
  syncManuscriptCommentDelete,
  syncManuscriptCommentUpdate,
  syncMemoCreate,
} from './sync-helpers';

export interface UseManuscriptCommentContext {
  projectId: string;
  userId: string;
}

export interface CreateManuscriptCommentInput {
  targetKind: CommentTargetKind;
  targetId: string;
  targetBlockId: string;
  anchorJson?: string;
  bodyJson: string;
  authorKind?: CommentAuthorKind;
  authorId?: string | null;
  authorName?: string | null;
  source?: CommentSource;
  priority?: CommentPriority | null;
  metadataJson?: string | null;
}

function commentSyncPayload(comment: ManuscriptComment): Record<string, unknown> {
  return {
    id: comment.id,
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
    resolvedAt: comment.resolvedAt,
  };
}

function actionSyncPayload(action: CommentAction): Record<string, unknown> {
  return {
    id: action.id,
    commentId: action.commentId,
    kind: action.kind,
    label: action.label,
    payloadJson: action.payloadJson,
    status: action.status,
    resultJson: action.resultJson,
    createdByKind: action.createdByKind,
    createdById: action.createdById,
    appliedAt: action.appliedAt,
  };
}

function memoSyncPayload(memo: Memo): Record<string, unknown> {
  return {
    id: memo.id,
    title: memo.title,
    bodyJson: memo.bodyJson,
    resolution: memo.resolution,
    priority: memo.priority,
    dueAt: memo.dueAt,
    orderKey: memo.orderKey,
    resolvedAt: memo.resolvedAt,
  };
}

export function useManuscriptComment({ projectId, userId }: UseManuscriptCommentContext) {
  if (!projectId) throw new Error('useManuscriptComment requires a projectId');
  if (!userId) throw new Error('useManuscriptComment requires a userId');

  const commentRepo = useMemo(() => createManuscriptCommentRepository(projectId), [projectId]);
  const actionRepo = useMemo(() => createCommentActionRepository(projectId), [projectId]);

  const ensureDb = useCallback(async () => {
    await initDatabase(userId);
  }, [userId]);

  const loadInitial = useCallback(async () => {
    await ensureDb();
    const [comments, actions] = await Promise.all([commentRepo.findAll(), actionRepo.findAll()]);
    const store = useDataStore.getState();
    store.setManuscriptComments(comments);
    store.setCommentActions(actions);
  }, [ensureDb, commentRepo, actionRepo]);

  const createComment = useCallback(
    async (input: CreateManuscriptCommentInput) => {
      await ensureDb();
      const prev = useDataStore.getState().manuscriptComments.slice();
      const now = new Date().toISOString();
      const comment: ManuscriptComment = {
        id: uuidv7(),
        projectId,
        targetKind: input.targetKind,
        targetId: input.targetId,
        targetBlockId: input.targetBlockId,
        anchorJson: input.anchorJson ?? '{}',
        authorKind: input.authorKind ?? 'user',
        authorId: input.authorId ?? userId,
        authorName: input.authorName ?? null,
        bodyJson: input.bodyJson,
        status: 'open',
        priority: input.priority ?? null,
        source: input.source ?? 'manual',
        metadataJson: input.metadataJson ?? null,
        resolvedAt: null,
        createdAt: now,
        updatedAt: now,
      };

      return withOptimisticUpdate({
        apply: () => useDataStore.getState().setManuscriptComments([...prev, comment]),
        rollback: () => useDataStore.getState().setManuscriptComments(prev),
        effect: () => commentRepo.create(comment),
        sync: (persisted) =>
          syncManuscriptCommentCreate(persisted.id, projectId, commentSyncPayload(persisted)),
      });
    },
    [ensureDb, projectId, userId, commentRepo],
  );

  const resolveComment = useCallback(
    async (id: string) => {
      await ensureDb();
      const comments = useDataStore.getState().manuscriptComments;
      const existing = comments.find((comment) => comment.id === id);
      if (!existing) throw new Error(`Comment with id ${id} not found`);

      const now = new Date().toISOString();
      const updated: ManuscriptComment = {
        ...existing,
        status: 'resolved',
        resolvedAt: now,
        updatedAt: now,
      };

      return withOptimisticUpdate({
        apply: () =>
          useDataStore
            .getState()
            .setManuscriptComments(comments.map((comment) => (comment.id === id ? updated : comment))),
        rollback: () => useDataStore.getState().setManuscriptComments(comments),
        effect: async () => {
          const persisted = await commentRepo.update(id, {
            status: updated.status,
            resolvedAt: updated.resolvedAt,
            updatedAt: updated.updatedAt,
          });
          if (!persisted) throw new Error(`Comment with id ${id} not found`);
          return persisted;
        },
        sync: (persisted) =>
          syncManuscriptCommentUpdate(persisted.id, projectId, {
            status: persisted.status,
            resolvedAt: persisted.resolvedAt,
          }),
      });
    },
    [ensureDb, projectId, commentRepo],
  );

  const reopenComment = useCallback(
    async (id: string) => {
      await ensureDb();
      const comments = useDataStore.getState().manuscriptComments;
      const existing = comments.find((comment) => comment.id === id);
      if (!existing) throw new Error(`Comment with id ${id} not found`);

      const now = new Date().toISOString();
      const updated: ManuscriptComment = {
        ...existing,
        status: 'open',
        resolvedAt: null,
        updatedAt: now,
      };

      return withOptimisticUpdate({
        apply: () =>
          useDataStore
            .getState()
            .setManuscriptComments(comments.map((comment) => (comment.id === id ? updated : comment))),
        rollback: () => useDataStore.getState().setManuscriptComments(comments),
        effect: async () => {
          const persisted = await commentRepo.update(id, {
            status: updated.status,
            resolvedAt: updated.resolvedAt,
            updatedAt: updated.updatedAt,
          });
          if (!persisted) throw new Error(`Comment with id ${id} not found`);
          return persisted;
        },
        sync: (persisted) =>
          syncManuscriptCommentUpdate(persisted.id, projectId, {
            status: persisted.status,
            resolvedAt: persisted.resolvedAt,
          }),
      });
    },
    [ensureDb, projectId, commentRepo],
  );

  const deleteComment = useCallback(
    async (id: string) => {
      await ensureDb();
      const state = useDataStore.getState();
      const comments = state.manuscriptComments;
      const actions = state.commentActions;
      const existing = comments.find((comment) => comment.id === id);
      if (!existing) throw new Error(`Comment with id ${id} not found`);

      return withOptimisticUpdate({
        apply: () => state.removeManuscriptComment(id),
        rollback: () => {
          useDataStore.getState().setManuscriptComments(comments);
          useDataStore.getState().setCommentActions(actions);
        },
        effect: () => commentRepo.delete(id),
        sync: () => syncManuscriptCommentDelete(id, projectId),
      });
    },
    [ensureDb, projectId, commentRepo],
  );

  const convertToMemo = useCallback(
    async (id: string) => {
      await ensureDb();
      const state = useDataStore.getState();
      const commentsBefore = state.manuscriptComments.slice();
      const actionsBefore = state.commentActions.slice();
      const memosBefore = state.memos.slice();
      const refsBefore = state.entityRelations.slice();
      const existing = commentsBefore.find((comment) => comment.id === id);
      if (!existing) throw new Error(`Comment with id ${id} not found`);
      if (existing.status === 'converted') return null;

      const now = new Date().toISOString();
      const bodyText = extractTextFromCommentBody(existing.bodyJson);
      const quote = getSelectedTextFromAnchor(existing.anchorJson);
      const title = bodyText.split('\n')[0]?.trim() || quote.trim() || '批注 TODO';

      const memo: Memo = {
        id: uuidv7(),
        projectId,
        title,
        bodyJson: createPlainCommentDoc(
          [bodyText, quote ? `原文：${quote}` : ''].filter(Boolean).join('\n\n'),
        ),
        resolution: 'unresolved',
        priority: existing.priority,
        dueAt: null,
        orderKey: 0,
        resolvedAt: null,
        createdAt: now,
        updatedAt: now,
      };

      // The comment's block anchor (targetBlockId) is dropped here — the memo
      // is associated with the whole entity, not the specific block. Block-
      // level anchoring belongs to manuscript_comment, not the relation table.
      const relation: EntityRelationLink = {
        id: uuidv7(),
        projectId,
        fromKind: 'memo',
        fromId: memo.id,
        toKind: existing.targetKind,
        toId: existing.targetId,
        kind: null,
        createdAt: now,
        updatedAt: now,
      };

      const action: CommentAction = {
        id: uuidv7(),
        projectId,
        commentId: existing.id,
        kind: 'convert_to_memo',
        label: 'Convert to memo TODO',
        payloadJson: JSON.stringify({ memoId: memo.id }),
        status: 'applied',
        resultJson: JSON.stringify({ memoId: memo.id, relationId: relation.id }),
        createdByKind: 'user',
        createdById: userId,
        createdAt: now,
        updatedAt: now,
        appliedAt: now,
      };

      const converted: ManuscriptComment = {
        ...existing,
        status: 'converted',
        resolvedAt: now,
        updatedAt: now,
      };

      try {
        const store = useDataStore.getState();
        store.setMemos([memo, ...memosBefore]);
        store.setEntityRelations([...refsBefore, relation]);
        store.setCommentActions([...actionsBefore, action]);
        store.setManuscriptComments(
          commentsBefore.map((comment) => (comment.id === id ? converted : comment)),
        );

        await getDb().transaction(async (tx) => {
          const txCommentRepo = createManuscriptCommentRepository(projectId, tx);
          const txActionRepo = createCommentActionRepository(projectId, tx);
          const txMemoRepo = createMemoSqliteRepository(projectId, tx);
          await txMemoRepo.create(memo);
          await tx.insert(EntityRelationTable).values(relation);
          await txCommentRepo.update(id, {
            status: converted.status,
            resolvedAt: converted.resolvedAt,
            updatedAt: converted.updatedAt,
          });
          await txActionRepo.create(action);
        });

        syncMemoCreate(memo.id, projectId, memoSyncPayload(memo));
        syncEntityRelationCreate(relation.id, projectId, {
          id: relation.id,
          fromKind: relation.fromKind,
          fromId: relation.fromId,
          toKind: relation.toKind,
          toId: relation.toId,
          kind: relation.kind,
        });
        syncManuscriptCommentUpdate(existing.id, projectId, {
          status: converted.status,
          resolvedAt: converted.resolvedAt,
        });
        syncCommentActionCreate(action.id, projectId, actionSyncPayload(action));

        return memo;
      } catch (error) {
        const store = useDataStore.getState();
        store.setManuscriptComments(commentsBefore);
        store.setCommentActions(actionsBefore);
        store.setMemos(memosBefore);
        store.setEntityRelations(refsBefore);
        throw error;
      }
    },
    [ensureDb, projectId, userId],
  );

  return useMemo(
    () => ({
      loadInitial,
      createComment,
      resolveComment,
      reopenComment,
      deleteComment,
      convertToMemo,
    }),
    [loadInitial, createComment, resolveComment, reopenComment, deleteComment, convertToMemo],
  );
}
