import { and, asc, eq } from 'drizzle-orm';
import { getDb, type DbExecutor } from '../lib/db';
import { CommentActionTable, ManuscriptCommentTable } from '../schema/drizzle';
import type {
  CommentAction,
  CommentActionKind,
  CommentActionStatus,
  CommentAuthorKind,
  CommentPriority,
  CommentSource,
  CommentTargetKind,
  ManuscriptComment,
  ManuscriptCommentStatus,
} from '../domain/manuscript-comment';

export type ManuscriptCommentCreateData = ManuscriptComment;
export type ManuscriptCommentUpdateData = Partial<
  Omit<ManuscriptComment, 'id' | 'projectId' | 'createdAt'>
> & {
  updatedAt: string;
};

export type CommentActionCreateData = CommentAction;
export type CommentActionUpdateData = Partial<
  Omit<CommentAction, 'id' | 'projectId' | 'commentId' | 'createdAt'>
> & {
  updatedAt: string;
};

export interface ManuscriptCommentRepository {
  findById(id: string): Promise<ManuscriptComment | null>;
  findAll(): Promise<ManuscriptComment[]>;
  create(input: ManuscriptCommentCreateData): Promise<ManuscriptComment>;
  update(id: string, data: ManuscriptCommentUpdateData): Promise<ManuscriptComment | null>;
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

function toCommentDomain(record: typeof ManuscriptCommentTable.$inferSelect): ManuscriptComment {
  return {
    id: record.id,
    projectId: record.projectId,
    targetKind: record.targetKind as CommentTargetKind,
    targetId: record.targetId,
    targetBlockId: record.targetBlockId,
    anchorJson: record.anchorJson,
    authorKind: record.authorKind as CommentAuthorKind,
    authorId: record.authorId,
    authorName: record.authorName,
    bodyJson: record.bodyJson,
    status: record.status as ManuscriptCommentStatus,
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

export function createManuscriptCommentRepository(
  projectId: string,
  dbOverride?: DbExecutor,
): ManuscriptCommentRepository {
  const dbProvider = () => dbOverride ?? getDb();

  const findById = async (id: string): Promise<ManuscriptComment | null> => {
    const rows = await dbProvider()
      .select()
      .from(ManuscriptCommentTable)
      .where(eq(ManuscriptCommentTable.id, id))
      .limit(1);
    return rows[0] ? toCommentDomain(rows[0]) : null;
  };

  const findAll = async (): Promise<ManuscriptComment[]> => {
    const rows = await dbProvider()
      .select()
      .from(ManuscriptCommentTable)
      .where(eq(ManuscriptCommentTable.projectId, projectId))
      .orderBy(asc(ManuscriptCommentTable.createdAt));
    return rows.map(toCommentDomain);
  };

  return {
    findById,
    findAll,
    create: async (input) => {
      const row: typeof ManuscriptCommentTable.$inferInsert = {
        id: input.id,
        projectId: input.projectId,
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
      await dbProvider().insert(ManuscriptCommentTable).values(row);
      return (await findById(input.id))!;
    },
    update: async (id, data) => {
      const updateValues: Partial<typeof ManuscriptCommentTable.$inferInsert> = {
        updatedAt: data.updatedAt,
      };
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
        .update(ManuscriptCommentTable)
        .set(updateValues)
        .where(eq(ManuscriptCommentTable.id, id));
      return findById(id);
    },
    delete: async (id) => {
      await dbProvider()
        .delete(ManuscriptCommentTable)
        .where(eq(ManuscriptCommentTable.id, id));
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
