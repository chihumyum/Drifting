import { and, asc, eq } from 'drizzle-orm';
import { getDb, type DbExecutor } from '../lib/db';
import { CommentActionTable, CommentTable } from '../schema/drizzle';
import type {
  Comment,
  CommentAction,
  CommentActionKind,
  CommentActionStatus,
  CommentAuthorKind,
  CommentKind,
  CommentPriority,
  CommentSource,
  CommentStatus,
  CommentTargetKind,
} from '../domain/comment';

export type CommentCreateData = Comment;
export type CommentUpdateData = Partial<
  Omit<Comment, 'id' | 'projectId' | 'createdAt'>
> & {
  updatedAt: string;
};

export type CommentActionCreateData = CommentAction;
export type CommentActionUpdateData = Partial<
  Omit<CommentAction, 'id' | 'projectId' | 'commentId' | 'createdAt'>
> & {
  updatedAt: string;
};

export interface CommentRepository {
  findById(id: string): Promise<Comment | null>;
  findAll(): Promise<Comment[]>;
  create(input: CommentCreateData): Promise<Comment>;
  update(id: string, data: CommentUpdateData): Promise<Comment | null>;
  delete(id: string): Promise<boolean>;
}

export interface CommentActionRepository {
  findById(id: string): Promise<CommentAction | null>;
  findAll(): Promise<CommentAction[]>;
  findByComment(commentId: string): Promise<CommentAction[]>;
  create(input: CommentActionCreateData): Promise<CommentAction>;
  update(id: string, data: CommentActionUpdateData): Promise<CommentAction | null>;
  delete(id: string): Promise<boolean>;
}

function toCommentDomain(record: typeof CommentTable.$inferSelect): Comment {
  return {
    id: record.id,
    projectId: record.projectId,
    kind: record.kind as CommentKind,
    targetKind: (record.targetKind as CommentTargetKind | null) ?? null,
    targetId: record.targetId,
    targetBlockId: record.targetBlockId,
    anchorJson: record.anchorJson,
    authorKind: record.authorKind as CommentAuthorKind,
    authorId: record.authorId,
    authorName: record.authorName,
    bodyJson: record.bodyJson,
    status: record.status as CommentStatus,
    priority: (record.priority as CommentPriority | null) ?? null,
    source: record.source as CommentSource,
    metadataJson: record.metadataJson,
    resolvedAt: record.resolvedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toActionDomain(record: typeof CommentActionTable.$inferSelect): CommentAction {
  return {
    id: record.id,
    projectId: record.projectId,
    commentId: record.commentId,
    kind: record.kind as CommentActionKind,
    label: record.label,
    payloadJson: record.payloadJson,
    status: record.status as CommentActionStatus,
    resultJson: record.resultJson,
    createdByKind: record.createdByKind as CommentAuthorKind,
    createdById: record.createdById,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    appliedAt: record.appliedAt,
  };
}

export function createCommentRepository(
  projectId: string,
  dbOverride?: DbExecutor,
): CommentRepository {
  const dbProvider = () => dbOverride ?? getDb();

  const findById = async (id: string): Promise<Comment | null> => {
    const rows = await dbProvider()
      .select()
      .from(CommentTable)
      .where(eq(CommentTable.id, id))
      .limit(1);
    return rows[0] ? toCommentDomain(rows[0]) : null;
  };

  const findAll = async (): Promise<Comment[]> => {
    const rows = await dbProvider()
      .select()
      .from(CommentTable)
      .where(eq(CommentTable.projectId, projectId))
      .orderBy(asc(CommentTable.createdAt));
    return rows.map(toCommentDomain);
  };

  return {
    findById,
    findAll,
    create: async (input) => {
      const row: typeof CommentTable.$inferInsert = {
        id: input.id,
        projectId: input.projectId,
        kind: input.kind,
        targetKind: input.targetKind,
        targetId: input.targetId,
        targetBlockId: input.targetBlockId,
        anchorJson: input.anchorJson,
        authorKind: input.authorKind,
        authorId: input.authorId,
        authorName: input.authorName,
        bodyJson: input.bodyJson,
        status: input.status,
        priority: input.priority,
        source: input.source,
        metadataJson: input.metadataJson,
        resolvedAt: input.resolvedAt,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      };
      await dbProvider().insert(CommentTable).values(row);
      return (await findById(input.id))!;
    },
    update: async (id, data) => {
      const updateValues: Partial<typeof CommentTable.$inferInsert> = {
        updatedAt: data.updatedAt,
      };
      if (data.kind !== undefined) updateValues.kind = data.kind;
      if (data.targetKind !== undefined) updateValues.targetKind = data.targetKind;
      if (data.targetId !== undefined) updateValues.targetId = data.targetId;
      if (data.targetBlockId !== undefined) updateValues.targetBlockId = data.targetBlockId;
      if (data.anchorJson !== undefined) updateValues.anchorJson = data.anchorJson;
      if (data.authorKind !== undefined) updateValues.authorKind = data.authorKind;
      if (data.authorId !== undefined) updateValues.authorId = data.authorId;
      if (data.authorName !== undefined) updateValues.authorName = data.authorName;
      if (data.bodyJson !== undefined) updateValues.bodyJson = data.bodyJson;
      if (data.status !== undefined) updateValues.status = data.status;
      if (data.priority !== undefined) updateValues.priority = data.priority;
      if (data.source !== undefined) updateValues.source = data.source;
      if (data.metadataJson !== undefined) updateValues.metadataJson = data.metadataJson;
      if (data.resolvedAt !== undefined) updateValues.resolvedAt = data.resolvedAt;

      await dbProvider()
        .update(CommentTable)
        .set(updateValues)
        .where(eq(CommentTable.id, id));
      return findById(id);
    },
    delete: async (id) => {
      await dbProvider()
        .delete(CommentTable)
        .where(eq(CommentTable.id, id));
      return true;
    },
  };
}

export function createCommentActionRepository(
  projectId: string,
  dbOverride?: DbExecutor,
): CommentActionRepository {
  const dbProvider = () => dbOverride ?? getDb();

  const findById = async (id: string): Promise<CommentAction | null> => {
    const rows = await dbProvider()
      .select()
      .from(CommentActionTable)
      .where(eq(CommentActionTable.id, id))
      .limit(1);
    return rows[0] ? toActionDomain(rows[0]) : null;
  };

  const findAll = async (): Promise<CommentAction[]> => {
    const rows = await dbProvider()
      .select()
      .from(CommentActionTable)
      .where(eq(CommentActionTable.projectId, projectId))
      .orderBy(asc(CommentActionTable.createdAt));
    return rows.map(toActionDomain);
  };

  return {
    findById,
    findAll,
    findByComment: async (commentId) => {
      const rows = await dbProvider()
        .select()
        .from(CommentActionTable)
        .where(and(eq(CommentActionTable.projectId, projectId), eq(CommentActionTable.commentId, commentId)))
        .orderBy(asc(CommentActionTable.createdAt));
      return rows.map(toActionDomain);
    },
    create: async (input) => {
      const row: typeof CommentActionTable.$inferInsert = {
        id: input.id,
        projectId: input.projectId,
        commentId: input.commentId,
        kind: input.kind,
        label: input.label,
        payloadJson: input.payloadJson,
        status: input.status,
        resultJson: input.resultJson,
        createdByKind: input.createdByKind,
        createdById: input.createdById,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
        appliedAt: input.appliedAt,
      };
      await dbProvider().insert(CommentActionTable).values(row);
      return (await findById(input.id))!;
    },
    update: async (id, data) => {
      const updateValues: Partial<typeof CommentActionTable.$inferInsert> = {
        updatedAt: data.updatedAt,
      };
      if (data.kind !== undefined) updateValues.kind = data.kind;
      if (data.label !== undefined) updateValues.label = data.label;
      if (data.payloadJson !== undefined) updateValues.payloadJson = data.payloadJson;
      if (data.status !== undefined) updateValues.status = data.status;
      if (data.resultJson !== undefined) updateValues.resultJson = data.resultJson;
      if (data.createdByKind !== undefined) updateValues.createdByKind = data.createdByKind;
      if (data.createdById !== undefined) updateValues.createdById = data.createdById;
      if (data.appliedAt !== undefined) updateValues.appliedAt = data.appliedAt;

      await dbProvider()
        .update(CommentActionTable)
        .set(updateValues)
        .where(eq(CommentActionTable.id, id));
      return findById(id);
    },
    delete: async (id) => {
      await dbProvider().delete(CommentActionTable).where(eq(CommentActionTable.id, id));
      return true;
    },
  };
}
