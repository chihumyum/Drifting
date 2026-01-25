import { getDb, type DbExecutor } from '../lib/db';
import { BookElementTable } from '../schema/drizzle';
import { eq, desc, and } from 'drizzle-orm';
import type { BookElement } from '../domain/book-element';

export type ElementCreateData = Omit<BookElement, 'tagIds' | 'stageIds'>;
export type ElementUpdateData = Partial<Omit<BookElement, 'id' | 'createdAt' | 'tagIds' | 'stageIds'>> & { updatedAt: string };

export interface ElementRepository {
    findById(id: string): Promise<BookElement | null>;
    findAll(): Promise<BookElement[]>;
    findAllByCategory(categoryId: string): Promise<BookElement[]>;
    create(input: ElementCreateData): Promise<BookElement>;
    update(id: string, element: ElementUpdateData): Promise<BookElement | null>;
    delete(id: string): Promise<boolean>;
}


function toDomain(record: typeof BookElementTable.$inferSelect): BookElement {
    return {
        id: record.id,
        projectId: record.projectId,
        categoryId: record.categoryId,
        name: record.name,
        summary: record.summary,
        contentJson: record.contentJson,
        tagIds: [],
        stageIds: [],
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
    };
}

export function createBookElementSqliteRepository(projectId: string, dbOverride?: DbExecutor): ElementRepository {
    const dbProvider = () => dbOverride ?? getDb();

    const findById = async (id: string): Promise<BookElement | null> => {
        const rows = await dbProvider().select()
            .from(BookElementTable)
            .where(eq(BookElementTable.id, id))
            .limit(1);

        if (rows.length === 0) return null;

        return rows[0] ? toDomain(rows[0]) : null;
    };

    const findAll = async (): Promise<BookElement[]> => {
        const rows = await dbProvider().select()
            .from(BookElementTable)
            .where(eq(BookElementTable.projectId, projectId))
            .orderBy(desc(BookElementTable.updatedAt));

        return rows.map(toDomain);
    };

    const findAllByCategory = async (categoryId: string): Promise<BookElement[]> => {
        const rows = await dbProvider().select()
            .from(BookElementTable)
            .where(and(
                eq(BookElementTable.projectId, projectId),
                eq(BookElementTable.categoryId, categoryId)
            ))
            .orderBy(desc(BookElementTable.updatedAt));

        return rows.map(toDomain);
    };

    const create = async (input: ElementCreateData): Promise<BookElement> => {

        const newElement: typeof BookElementTable.$inferInsert = {
            id: input.id,
            projectId: input.projectId,
            categoryId: input.categoryId,
            name: input.name,
            summary: input.summary,
            contentJson: input.contentJson,
            createdAt: input.createdAt,
            updatedAt: input.updatedAt,
        };

        await dbProvider().insert(BookElementTable).values(newElement);

        return (await findById(input.id))!;
    };

    const update = async (id: string, data: ElementUpdateData): Promise<BookElement | null> => {
        if (!data.updatedAt) {
            throw new Error('updatedAt is required for updating an element');
        }

        const updateValues: Partial<typeof BookElementTable.$inferInsert> = {
            updatedAt: data.updatedAt,
        };
        if (data.categoryId !== undefined) updateValues.categoryId = data.categoryId;
        if (data.name !== undefined) updateValues.name = data.name;
        if (data.summary !== undefined) updateValues.summary = data.summary;
        if (data.contentJson !== undefined) updateValues.contentJson = data.contentJson;

        await dbProvider().update(BookElementTable)
            .set(updateValues)
            .where(eq(BookElementTable.id, id));

        return findById(id);
    };

    return {
        findById,
        findAll,
        findAllByCategory,
        create,
        update,
        delete: async (id) => {
            await dbProvider().delete(BookElementTable).where(eq(BookElementTable.id, id));
            return true;
        },
    };
}
