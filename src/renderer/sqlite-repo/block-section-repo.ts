import { v7 as uuidv7 } from 'uuid';
import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '../lib/db';
import { BlockSectionTable } from '../schema/drizzle';
import {
  decodeBlockHashes,
  decodeBlockIds,
  encodeBlockHashes,
  encodeBlockIds,
  type BlockSection,
  type BlockSectionSource,
} from '../domain/block-section';

export interface CreateBlockSectionInput {
  /** Optional — auto-generated UUIDv7 when omitted. */
  id?: string;
  projectId: string;
  chapterId: string;
  blockIds: string[];
  blockHashes: Record<string, string>;
  summary: string;
  source?: BlockSectionSource;
}

export type UpdateBlockSectionInput = Partial<
  Pick<BlockSection, 'blockIds' | 'blockHashes' | 'summary' | 'source'>
>;

export interface BlockSectionRepository {
  create(input: CreateBlockSectionInput): Promise<BlockSection>;
  update(id: string, updates: UpdateBlockSectionInput): Promise<BlockSection | null>;
  delete(id: string): Promise<void>;
  findById(id: string): Promise<BlockSection | null>;
  findByChapter(chapterId: string): Promise<BlockSection[]>;
  findByProject(projectId: string): Promise<BlockSection[]>;
}

function toDomain(row: typeof BlockSectionTable.$inferSelect): BlockSection {
  return {
    id: row.id,
    projectId: row.projectId,
    chapterId: row.chapterId,
    blockIds: decodeBlockIds(row.blockIdsJson),
    blockHashes: decodeBlockHashes(row.blockHashesJson),
    summary: row.summary,
    source: (row.source as BlockSectionSource) ?? 'copilot-rolling',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createBlockSectionRepository(): BlockSectionRepository {
  const create = async (input: CreateBlockSectionInput): Promise<BlockSection> => {
    const db = getDb();
    const now = new Date().toISOString();
    const row = {
      id: input.id ?? uuidv7(),
      projectId: input.projectId,
      chapterId: input.chapterId,
      blockIdsJson: encodeBlockIds(input.blockIds),
      blockHashesJson: encodeBlockHashes(input.blockHashes),
      summary: input.summary,
      source: input.source ?? 'copilot-rolling',
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(BlockSectionTable).values(row);
    return toDomain(row as typeof BlockSectionTable.$inferSelect);
  };

  const update = async (
    id: string,
    updates: UpdateBlockSectionInput,
  ): Promise<BlockSection | null> => {
    const db = getDb();
    const now = new Date().toISOString();
    const setValues: Record<string, unknown> = { updatedAt: now };
    if (updates.blockIds !== undefined) setValues.blockIdsJson = encodeBlockIds(updates.blockIds);
    if (updates.blockHashes !== undefined) {
      setValues.blockHashesJson = encodeBlockHashes(updates.blockHashes);
    }
    if (updates.summary !== undefined) setValues.summary = updates.summary;
    if (updates.source !== undefined) setValues.source = updates.source;

    await db.update(BlockSectionTable).set(setValues).where(eq(BlockSectionTable.id, id));
    const rows = await db
      .select()
      .from(BlockSectionTable)
      .where(eq(BlockSectionTable.id, id))
      .limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  };

  const deleteSection = async (id: string): Promise<void> => {
    await getDb().delete(BlockSectionTable).where(eq(BlockSectionTable.id, id));
  };

  const findById = async (id: string): Promise<BlockSection | null> => {
    const rows = await getDb()
      .select()
      .from(BlockSectionTable)
      .where(eq(BlockSectionTable.id, id))
      .limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  };

  const findByChapter = async (chapterId: string): Promise<BlockSection[]> => {
    const rows = await getDb()
      .select()
      .from(BlockSectionTable)
      .where(eq(BlockSectionTable.chapterId, chapterId))
      .orderBy(asc(BlockSectionTable.createdAt));
    return rows.map(toDomain);
  };

  const findByProject = async (projectId: string): Promise<BlockSection[]> => {
    const rows = await getDb()
      .select()
      .from(BlockSectionTable)
      .where(and(eq(BlockSectionTable.projectId, projectId)))
      .orderBy(asc(BlockSectionTable.chapterId), asc(BlockSectionTable.createdAt));
    return rows.map(toDomain);
  };

  return {
    create,
    update,
    delete: deleteSection,
    findById,
    findByChapter,
    findByProject,
  };
}
