import { useCallback, useMemo } from 'react';
import { v7 as uuidv7 } from 'uuid';
import { initDatabase } from '../lib/db';
import { events } from '../lib/events';
import { removeNoteTaskLines } from '../lib/note-task-document';
import { createLibraryItemUsecases } from './useLibraryItem';
import type {
  Comment,
  CommentAction,
  CommentAuthorKind,
  CommentKind,
  CommentPriority,
  CommentSource,
  CommentTargetKind,
} from '../domain/comment';
import {
  createCommentActionRepository,
  createCommentRepository,
} from '../sqlite-repo/comment-repo';
import { useDataStore } from '../store/data-store';
import { withOptimisticUpdate } from './optimistic';
import { withAtomicSyncTransaction } from './sync-helpers';
import {
  deleteEntityRelationsInTransaction,
  withoutRelationsForEntity,
} from './entity-relation-cleanup';

export interface UseCommentContext {
  projectId: string;
  userId: string;
}

export interface CreateCommentInput {
  /** 'note' for annotations, 'todo' for tasks in the shared Review surface. */
  kind?: CommentKind;
  /** All three target fields are optional. Omit for floating (project-level) TODOs. */
  targetKind?: CommentTargetKind | null;
  targetId?: string | null;
  targetBlockId?: string | null;
  /** Consecutive block range the comment anchors to (incl. the first). Serialized
   *  into targetBlockIdsJson; anchored Review cards can jump to the full range. */
  targetBlockIds?: string[];
  anchorJson?: string;
  bodyJson: string;
  authorKind?: CommentAuthorKind;
  authorId?: string | null;
  authorName?: string | null;
  source?: CommentSource;
  priority?: CommentPriority | null;
  metadataJson?: string | null;
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

export function useComment({ projectId, userId }: UseCommentContext) {
  if (!projectId) throw new Error('useComment requires a projectId');
  if (!userId) throw new Error('useComment requires a userId');

  const commentRepo = useMemo(() => createCommentRepository(projectId), [projectId]);
  const actionRepo = useMemo(() => createCommentActionRepository(projectId), [projectId]);

  const ensureDb = useCallback(async () => {
    await initDatabase(userId);
  }, [userId]);

  const loadInitial = useCallback(async () => {
    await ensureDb();
    const [comments, actions] = await Promise.all([commentRepo.findAll(), actionRepo.findAll()]);
    const store = useDataStore.getState();
    store.setComments(comments);
    store.setCommentActions(actions);
  }, [ensureDb, commentRepo, actionRepo]);

  const createComment = useCallback(
    async (input: CreateCommentInput) => {
      await ensureDb();
      const prev = useDataStore.getState().comments.slice();
      const now = new Date().toISOString();
      const comment: Comment = {
        id: uuidv7(),
        projectId,
        kind: input.kind ?? 'note',
        targetKind: input.targetKind ?? null,
        targetId: input.targetId ?? null,
        targetBlockId: input.targetBlockId ?? null,
        anchorJson: input.anchorJson ?? '{}',
        authorKind: input.authorKind ?? 'user',
        authorId: input.authorId ?? userId,
        authorName: input.authorName ?? null,
        bodyJson: input.bodyJson,
        status: 'open',
        priority: input.priority ?? null,
        source: input.source ?? 'manual',
        metadataJson: input.metadataJson ?? null,
        targetBlockIdsJson: JSON.stringify(input.targetBlockIds ?? []),
        resolvedAt: null,
        createdAt: now,
        updatedAt: now,
      };

      return withOptimisticUpdate({
        apply: () => useDataStore.getState().setComments([...prev, comment]),
        rollback: () => useDataStore.getState().setComments(prev),
        effect: () =>
          withAtomicSyncTransaction(projectId, async (tx, sync) => {
            const persisted = await createCommentRepository(projectId, tx).create(comment);
            await sync('comment', 'create', persisted.id, projectId, commentSyncPayload(persisted));
            return persisted;
          }),
      });
    },
    [ensureDb, projectId, userId],
  );

  const recordAgentTaskLaunch = useCallback(
    async (commentId: string, conversationId: string): Promise<CommentAction> => {
      await ensureDb();
      const comment = await commentRepo.findById(commentId);
      if (!comment || comment.kind !== 'todo') {
        throw new Error('The TODO is no longer available');
      }
      const existing = (await actionRepo.findByComment(commentId)).find(
        (action) => action.kind === 'start_agent_task' && action.status === 'applied',
      );
      if (existing) return existing;
      const now = new Date().toISOString();
      const action: CommentAction = {
        id: uuidv7(),
        projectId,
        commentId,
        kind: 'start_agent_task',
        label: 'Start Agent task',
        payloadJson: '{}',
        status: 'applied',
        resultJson: JSON.stringify({ conversationId }),
        createdByKind: 'user',
        createdById: userId,
        createdAt: now,
        updatedAt: now,
        appliedAt: now,
      };
      await withAtomicSyncTransaction(projectId, async (tx, sync) => {
        await createCommentActionRepository(projectId, tx).create(action);
        await sync('commentAction', 'create', action.id, projectId, actionSyncPayload(action));
      });
      useDataStore.getState().addCommentAction(action);
      return action;
    },
    [actionRepo, commentRepo, ensureDb, projectId, userId],
  );

  const resolveComment = useCallback(
    async (id: string) => {
      await ensureDb();
      const comments = useDataStore.getState().comments;
      const existing = comments.find((comment) => comment.id === id);
      if (!existing) throw new Error(`Comment with id ${id} not found`);

      const now = new Date().toISOString();
      const updated: Comment = {
        ...existing,
        status: 'resolved',
        resolvedAt: now,
        updatedAt: now,
      };

      return withOptimisticUpdate({
        apply: () =>
          useDataStore
            .getState()
            .setComments(comments.map((comment) => (comment.id === id ? updated : comment))),
        rollback: () => useDataStore.getState().setComments(comments),
        effect: async () => {
          return withAtomicSyncTransaction(projectId, async (tx, sync) => {
            const persisted = await createCommentRepository(projectId, tx).update(id, {
              status: updated.status,
              resolvedAt: updated.resolvedAt,
              updatedAt: updated.updatedAt,
            });
            if (!persisted) throw new Error(`Comment with id ${id} not found`);
            await sync('comment', 'update', persisted.id, projectId, {
              status: persisted.status,
              resolvedAt: persisted.resolvedAt,
            });
            return persisted;
          });
        },
      });
    },
    [ensureDb, projectId],
  );

  const reopenComment = useCallback(
    async (id: string) => {
      await ensureDb();
      const comments = useDataStore.getState().comments;
      const existing = comments.find((comment) => comment.id === id);
      if (!existing) throw new Error(`Comment with id ${id} not found`);

      const now = new Date().toISOString();
      const updated: Comment = {
        ...existing,
        status: 'open',
        resolvedAt: null,
        updatedAt: now,
      };

      return withOptimisticUpdate({
        apply: () =>
          useDataStore
            .getState()
            .setComments(comments.map((comment) => (comment.id === id ? updated : comment))),
        rollback: () => useDataStore.getState().setComments(comments),
        effect: async () => {
          return withAtomicSyncTransaction(projectId, async (tx, sync) => {
            const persisted = await createCommentRepository(projectId, tx).update(id, {
              status: updated.status,
              resolvedAt: updated.resolvedAt,
              updatedAt: updated.updatedAt,
            });
            if (!persisted) throw new Error(`Comment with id ${id} not found`);
            await sync('comment', 'update', persisted.id, projectId, {
              status: persisted.status,
              resolvedAt: persisted.resolvedAt,
            });
            return persisted;
          });
        },
      });
    },
    [ensureDb, projectId],
  );

  const updateCommentBody = useCallback(
    async (id: string, bodyJson: string) => {
      await ensureDb();
      const comments = useDataStore.getState().comments;
      const existing = comments.find((comment) => comment.id === id);
      if (!existing) throw new Error(`Comment with id ${id} not found`);

      const updated: Comment = {
        ...existing,
        bodyJson,
        updatedAt: new Date().toISOString(),
      };
      return withOptimisticUpdate({
        apply: () =>
          useDataStore
            .getState()
            .setComments(comments.map((comment) => (comment.id === id ? updated : comment))),
        rollback: () => useDataStore.getState().setComments(comments),
        effect: () =>
          withAtomicSyncTransaction(projectId, async (tx, sync) => {
            const persisted = await createCommentRepository(projectId, tx).update(id, {
              bodyJson: updated.bodyJson,
              updatedAt: updated.updatedAt,
            });
            if (!persisted) throw new Error(`Comment with id ${id} not found`);
            await sync('comment', 'update', persisted.id, projectId, {
              bodyJson: persisted.bodyJson,
            });
            return persisted;
          }),
      });
    },
    [ensureDb, projectId],
  );

  const deleteComment = useCallback(
    async (id: string) => {
      await ensureDb();
      const state = useDataStore.getState();
      const comments = state.comments;
      const actions = state.commentActions;
      const relations = state.entityRelations;
      const existing = comments.find((comment) => comment.id === id);
      if (!existing) throw new Error(`Comment with id ${id} not found`);
      const remainingRelations = withoutRelationsForEntity(
        relations,
        projectId,
        'comment',
        id,
      );
      // A TODO projected from a note task takes its checklist line with it, so
      // the note does not project it again (docs/material-workbench.md). The
      // line goes first, so the note never shows a line whose TODO is gone.
      if (existing.kind === 'todo' && existing.targetKind === 'library_item' && existing.targetId) {
        const noteId = existing.targetId;
        try {
          const bodyJson = await removeNoteTaskLines(projectId, noteId, [id]);
          if (bodyJson !== null) {
            await createLibraryItemUsecases({ projectId, userId }).projectNoteBody(noteId, bodyJson);
          }
        } catch (error) {
          console.warn('[comment] failed to remove the note task line:', error);
        }
      }

      const result = await withOptimisticUpdate({
        apply: () => {
          state.removeComment(id);
          state.setEntityRelations(remainingRelations);
        },
        rollback: () => {
          useDataStore.getState().setComments(comments);
          useDataStore.getState().setCommentActions(actions);
          useDataStore.getState().setEntityRelations(relations);
        },
        effect: () =>
          withAtomicSyncTransaction(projectId, async (tx, sync) => {
            await deleteEntityRelationsInTransaction(tx, sync, projectId, 'comment', id);
            const result = await createCommentRepository(projectId, tx).delete(id);
            await sync('comment', 'delete', id, projectId);
            return result;
          }),
      });
      events.emit('comment:deleted', { commentId: id });
      return result;
    },
    [ensureDb, projectId, userId],
  );

  // Promote a note-style comment to a TODO. In the consolidated model this is
  // just an in-place kind flip: the block anchor (if any) is preserved so the
  // promoted TODO still surfaces at its original position AND in the global
  // TODO list. No new comment row, no entity_relation, no action audit —
  // there's nothing to converge across.
  const convertToTodo = useCallback(
    async (id: string) => {
      await ensureDb();
      const comments = useDataStore.getState().comments;
      const existing = comments.find((comment) => comment.id === id);
      if (!existing) throw new Error(`Comment with id ${id} not found`);
      if (existing.kind === 'todo') return existing;

      const now = new Date().toISOString();
      const updated: Comment = { ...existing, kind: 'todo', updatedAt: now };

      return withOptimisticUpdate({
        apply: () =>
          useDataStore
            .getState()
            .setComments(comments.map((c) => (c.id === id ? updated : c))),
        rollback: () => useDataStore.getState().setComments(comments),
        effect: async () => {
          return withAtomicSyncTransaction(projectId, async (tx, sync) => {
            const persisted = await createCommentRepository(projectId, tx).update(id, {
              kind: updated.kind,
              updatedAt: updated.updatedAt,
            });
            if (!persisted) throw new Error(`Comment with id ${id} not found`);
            await sync('comment', 'update', persisted.id, projectId, { kind: persisted.kind });
            return persisted;
          });
        },
      });
    },
    [ensureDb, projectId],
  );

  // Inverse of convertToTodo: flip kind back to 'note' in place. Used by the
  // editor rail "downgrade" affordance when the user wants the row to behave
  // as a plain annotation again (drops it from the right-sidebar TODO list,
  // keeps the block anchor and body intact).
  const revertToNote = useCallback(
    async (id: string) => {
      await ensureDb();
      const comments = useDataStore.getState().comments;
      const existing = comments.find((comment) => comment.id === id);
      if (!existing) throw new Error(`Comment with id ${id} not found`);
      if (existing.kind === 'note') return existing;

      const now = new Date().toISOString();
      const updated: Comment = { ...existing, kind: 'note', updatedAt: now };

      return withOptimisticUpdate({
        apply: () =>
          useDataStore
            .getState()
            .setComments(comments.map((c) => (c.id === id ? updated : c))),
        rollback: () => useDataStore.getState().setComments(comments),
        effect: async () => {
          return withAtomicSyncTransaction(projectId, async (tx, sync) => {
            const persisted = await createCommentRepository(projectId, tx).update(id, {
              kind: updated.kind,
              updatedAt: updated.updatedAt,
            });
            if (!persisted) throw new Error(`Comment with id ${id} not found`);
            await sync('comment', 'update', persisted.id, projectId, { kind: persisted.kind });
            return persisted;
          });
        },
      });
    },
    [ensureDb, projectId],
  );

  return useMemo(
    () => ({
      loadInitial,
      createComment,
      recordAgentTaskLaunch,
      resolveComment,
      reopenComment,
      updateCommentBody,
      deleteComment,
      convertToTodo,
      revertToNote,
    }),
    [
      loadInitial,
      createComment,
      recordAgentTaskLaunch,
      resolveComment,
      reopenComment,
      updateCommentBody,
      deleteComment,
      convertToTodo,
      revertToNote,
    ],
  );
}
