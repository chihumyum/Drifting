import { useCallback, useMemo } from 'react';
import { v7 as uuidv7 } from 'uuid';
import { initDatabase, getDb } from '../lib/db';
import { createPlainCommentDoc } from '../domain/comment';
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
  encodeCopilotMetadata,
  type AcceptCopilotResult,
  type CopilotSuggestionMetadata,
} from '../domain/copilot-suggestion';
import {
  createCommentActionRepository,
  createCommentRepository,
} from '../sqlite-repo/comment-repo';
import { useDataStore } from '../store/data-store';
import { withOptimisticUpdate } from './optimistic';
import {
  syncCommentActionCreate,
  syncCommentCreate,
  syncCommentDelete,
  syncCommentUpdate,
} from './sync-helpers';

export interface UseCommentContext {
  projectId: string;
  userId: string;
}

export interface CreateCommentInput {
  /** 'note' for editor-anchored annotations, 'todo' for right-sidebar tasks. */
  kind?: CommentKind;
  /** All three target fields are optional. Omit for floating (project-level) TODOs. */
  targetKind?: CommentTargetKind | null;
  targetId?: string | null;
  targetBlockId?: string | null;
  /** Consecutive block range the comment anchors to (incl. the first). Serialized
   *  into targetBlockIdsJson; CommentRail anchor-marks + hover-highlights all of them. */
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

/**
 * Copilot-flavored variant of CreateCommentInput. Hard-codes
 * authorKind/source/authorName to the copilot defaults, requires structured
 * metadata, and auto-builds bodyJson from the metadata if the caller doesn't
 * supply one. Kept separate from CreateCommentInput so type-level mistakes
 * (e.g. forgetting to set source: 'copilot') become impossible.
 */
export interface CreateCopilotSuggestionInput {
  targetKind: CommentTargetKind;
  targetId: string;
  targetBlockId: string;
  /** Consecutive block range (unified anchor). Defaults to [targetBlockId]. */
  targetBlockIds?: string[];
  /** Encoded CommentAnchorPayload — typically built around the evidence span. */
  anchorJson: string;
  /** Typed copilot metadata; serialized into the comment's metadataJson. */
  metadata: CopilotSuggestionMetadata;
  /** Optional human-readable body. Auto-generated from metadata if omitted. */
  bodyJson?: string;
  priority?: CommentPriority | null;
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
        effect: () => commentRepo.create(comment),
        sync: (persisted) =>
          syncCommentCreate(persisted.id, projectId, commentSyncPayload(persisted)),
      });
    },
    [ensureDb, projectId, userId, commentRepo],
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
          const persisted = await commentRepo.update(id, {
            status: updated.status,
            resolvedAt: updated.resolvedAt,
            updatedAt: updated.updatedAt,
          });
          if (!persisted) throw new Error(`Comment with id ${id} not found`);
          return persisted;
        },
        sync: (persisted) =>
          syncCommentUpdate(persisted.id, projectId, {
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
          const persisted = await commentRepo.update(id, {
            status: updated.status,
            resolvedAt: updated.resolvedAt,
            updatedAt: updated.updatedAt,
          });
          if (!persisted) throw new Error(`Comment with id ${id} not found`);
          return persisted;
        },
        sync: (persisted) =>
          syncCommentUpdate(persisted.id, projectId, {
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
      const comments = state.comments;
      const actions = state.commentActions;
      const existing = comments.find((comment) => comment.id === id);
      if (!existing) throw new Error(`Comment with id ${id} not found`);

      return withOptimisticUpdate({
        apply: () => state.removeComment(id),
        rollback: () => {
          useDataStore.getState().setComments(comments);
          useDataStore.getState().setCommentActions(actions);
        },
        effect: () => commentRepo.delete(id),
        sync: () => syncCommentDelete(id, projectId),
      });
    },
    [ensureDb, projectId, commentRepo],
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
          const persisted = await commentRepo.update(id, {
            kind: updated.kind,
            updatedAt: updated.updatedAt,
          });
          if (!persisted) throw new Error(`Comment with id ${id} not found`);
          return persisted;
        },
        sync: (persisted) =>
          syncCommentUpdate(persisted.id, projectId, { kind: persisted.kind }),
      });
    },
    [ensureDb, projectId, commentRepo],
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
          const persisted = await commentRepo.update(id, {
            kind: updated.kind,
            updatedAt: updated.updatedAt,
          });
          if (!persisted) throw new Error(`Comment with id ${id} not found`);
          return persisted;
        },
        sync: (persisted) =>
          syncCommentUpdate(persisted.id, projectId, { kind: persisted.kind }),
      });
    },
    [ensureDb, projectId, commentRepo],
  );

  // Generalized in-place kind flip (note | todo | exception). convertToTodo /
  // revertToNote are the note↔todo special cases; this also reaches 'exception'
  // — a manual, block-anchored "this is intentional" the Shadow engine reads so
  // it won't re-flag the passage. Block anchor + body are preserved; same
  // optimistic-update + sync path as the note/todo flips.
  const setCommentKind = useCallback(
    async (id: string, kind: CommentKind) => {
      await ensureDb();
      const comments = useDataStore.getState().comments;
      const existing = comments.find((comment) => comment.id === id);
      if (!existing) throw new Error(`Comment with id ${id} not found`);
      if (existing.kind === kind) return existing;

      const now = new Date().toISOString();
      const updated: Comment = { ...existing, kind, updatedAt: now };

      return withOptimisticUpdate({
        apply: () =>
          useDataStore
            .getState()
            .setComments(comments.map((c) => (c.id === id ? updated : c))),
        rollback: () => useDataStore.getState().setComments(comments),
        effect: async () => {
          const persisted = await commentRepo.update(id, {
            kind: updated.kind,
            updatedAt: updated.updatedAt,
          });
          if (!persisted) throw new Error(`Comment with id ${id} not found`);
          return persisted;
        },
        sync: (persisted) =>
          syncCommentUpdate(persisted.id, projectId, { kind: persisted.kind }),
      });
    },
    [ensureDb, projectId, commentRepo],
  );

  const createCopilotSuggestion = useCallback(
    async (input: CreateCopilotSuggestionInput) => {
      await ensureDb();
      const prev = useDataStore.getState().comments.slice();
      const now = new Date().toISOString();
      const comment: Comment = {
        id: uuidv7(),
        projectId,
        kind: 'note',
        targetKind: input.targetKind,
        targetId: input.targetId,
        targetBlockId: input.targetBlockId,
        anchorJson: input.anchorJson,
        authorKind: 'copilot',
        authorId: null,
        authorName: 'Copilot',
        bodyJson: input.bodyJson ?? buildCopilotBody(input.metadata),
        status: 'open',
        priority: input.priority ?? null,
        source: 'copilot',
        metadataJson: encodeCopilotMetadata(input.metadata),
        targetBlockIdsJson: JSON.stringify(input.targetBlockIds ?? [input.targetBlockId]),
        resolvedAt: null,
        createdAt: now,
        updatedAt: now,
      };

      return withOptimisticUpdate({
        apply: () => useDataStore.getState().setComments([...prev, comment]),
        rollback: () => useDataStore.getState().setComments(prev),
        effect: () => commentRepo.create(comment),
        sync: (persisted) =>
          syncCommentCreate(persisted.id, projectId, commentSyncPayload(persisted)),
      });
    },
    [ensureDb, projectId, commentRepo],
  );

  // Shared backbone for accept/reject: append an action row, mark the
  // comment 'converted' so it disappears from CommentRail's open list, but
  // keep the row around as audit + dedup memory (queryable via
  // comment_action.kind='reject_suggestion'). Status='converted' is reused
  // rather than introducing a new terminal status — the action.kind already
  // carries the semantic, and UI filtering already excludes 'converted'.
  const recordSuggestionTerminal = useCallback(
    async (
      commentId: string,
      actionKind: 'accept_suggestion' | 'reject_suggestion',
      payload: Record<string, unknown>,
      result: Record<string, unknown> | null,
      label: string,
    ): Promise<CommentAction> => {
      await ensureDb();
      const state = useDataStore.getState();
      const commentsBefore = state.comments.slice();
      const actionsBefore = state.commentActions.slice();
      const existing = commentsBefore.find((c) => c.id === commentId);
      if (!existing) throw new Error(`Comment with id ${commentId} not found`);
      if (existing.source !== 'copilot') {
        throw new Error(`Comment ${commentId} is not a copilot suggestion (source=${existing.source})`);
      }
      if (existing.status !== 'open') {
        throw new Error(`Comment ${commentId} already terminal (status=${existing.status})`);
      }

      const now = new Date().toISOString();
      const action: CommentAction = {
        id: uuidv7(),
        projectId,
        commentId,
        kind: actionKind,
        label,
        payloadJson: JSON.stringify(payload),
        status: 'applied',
        resultJson: result ? JSON.stringify(result) : null,
        createdByKind: 'user',
        createdById: userId,
        createdAt: now,
        updatedAt: now,
        appliedAt: now,
      };
      const updatedComment: Comment = {
        ...existing,
        status: 'converted',
        resolvedAt: now,
        updatedAt: now,
      };

      try {
        const store = useDataStore.getState();
        store.setCommentActions([...actionsBefore, action]);
        store.setComments(
          commentsBefore.map((c) => (c.id === commentId ? updatedComment : c)),
        );

        await getDb().transaction(async (tx) => {
          const txCommentRepo = createCommentRepository(projectId, tx);
          const txActionRepo = createCommentActionRepository(projectId, tx);
          await txCommentRepo.update(commentId, {
            status: updatedComment.status,
            resolvedAt: updatedComment.resolvedAt,
            updatedAt: updatedComment.updatedAt,
          });
          await txActionRepo.create(action);
        });

        syncCommentUpdate(commentId, projectId, {
          status: updatedComment.status,
          resolvedAt: updatedComment.resolvedAt,
        });
        syncCommentActionCreate(action.id, projectId, actionSyncPayload(action));

        return action;
      } catch (error) {
        const store = useDataStore.getState();
        store.setComments(commentsBefore);
        store.setCommentActions(actionsBefore);
        throw error;
      }
    },
    [ensureDb, projectId, userId],
  );

  const acceptCopilotSuggestion = useCallback(
    async (commentId: string, result: AcceptCopilotResult) => {
      const existing = useDataStore.getState().comments.find((c) => c.id === commentId);
      const payload = existing?.metadataJson ? JSON.parse(existing.metadataJson) : {};
      return recordSuggestionTerminal(
        commentId,
        'accept_suggestion',
        payload as Record<string, unknown>,
        result as unknown as Record<string, unknown>,
        'Accept copilot suggestion',
      );
    },
    [recordSuggestionTerminal],
  );

  const rejectCopilotSuggestion = useCallback(
    async (commentId: string, reason?: string) => {
      const existing = useDataStore.getState().comments.find((c) => c.id === commentId);
      const payload = existing?.metadataJson ? JSON.parse(existing.metadataJson) : {};
      return recordSuggestionTerminal(
        commentId,
        'reject_suggestion',
        payload as Record<string, unknown>,
        reason ? { reason } : null,
        'Reject copilot suggestion',
      );
    },
    [recordSuggestionTerminal],
  );

  return useMemo(
    () => ({
      loadInitial,
      createComment,
      resolveComment,
      reopenComment,
      deleteComment,
      convertToTodo,
      revertToNote,
      setCommentKind,
      createCopilotSuggestion,
      acceptCopilotSuggestion,
      rejectCopilotSuggestion,
    }),
    [
      loadInitial,
      createComment,
      resolveComment,
      reopenComment,
      deleteComment,
      convertToTodo,
      revertToNote,
      setCommentKind,
      createCopilotSuggestion,
      acceptCopilotSuggestion,
      rejectCopilotSuggestion,
    ],
  );
}

/**
 * Auto-generate a human-readable body for a copilot suggestion comment when
 * the caller doesn't supply one.
 */
function buildCopilotBody(meta: CopilotSuggestionMetadata): string {
  switch (meta.kind) {
    case 'element-candidate': {
      const pct = Math.round(meta.confidence * 100);
      return createPlainCommentDoc(
        `Possible new ${meta.suggestedCategoryHint}: "${meta.suggestedName}" (${pct}% confident)`,
      );
    }
    default:
      // Exhaustiveness check — future metadata kinds must add a case.
      return createPlainCommentDoc('Copilot suggestion');
  }
}
