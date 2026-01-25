import { getDb } from '../lib/db';
import { BookElementTable, ElementCategoryTable, ElementTagTable, ElementTagLinkTable } from '../schema/drizzle';
import { eq, desc, and, inArray } from 'drizzle-orm';
import type { BookElement } from '../domain/book-element';
import { v7 as uuidv7 } from 'uuid';

const elementTagsLink = ElementTagLinkTable;

export type ElementUpdateData = Partial<Omit<BookElement, 'id' | 'createdAt'>> & { updatedAt: string };

export interface ElementRepository {
    findById(id: string): Promise<BookElement | null>;
    findAll(): Promise<BookElement[]>;
    findAllByCategory(categoryId: string): Promise<BookElement[]>;
    findAllByTagId(tagId: string): Promise<BookElement[]>;
    create(input: BookElement): Promise<BookElement>;
    update(id: string, element: ElementUpdateData): Promise<BookElement | null>;
    delete(id: string): Promise<boolean>;
    getElementTags(elementId: string): Promise<string[]>;
    addElementTag(elementId: string, tag: string): Promise<void>;
    removeElementTag(elementId: string, tag: string): Promise<void>;
    setElementTags(elementId: string, tags: string[]): Promise<void>;
}


async function getTagMap(elementIds: string[]): Promise<Record<string, string[]>> {
    if (!elementIds.length) return {};

    const rows = await getDb().select({
        elementId: elementTagsLink.elementId,
        tagName: ElementTagTable.name
    })
        .from(elementTagsLink)
        .innerJoin(ElementTagTable, eq(elementTagsLink.tagId, ElementTagTable.id))
        .where(inArray(elementTagsLink.elementId, elementIds));

    const map: Record<string, string[]> = {};
    for (const r of rows) {
        if (!map[r.elementId]) map[r.elementId] = [];
        map[r.elementId].push(r.tagName);
    }
    return map;
}

async function rowsToDomain(rows: Array<typeof BookElementTable.$inferSelect>): Promise<BookElement[]> {
    const elementIds = rows.map(r => r.id);
    const tagMap = await getTagMap(elementIds);

    return rows.map(r => ({
        id: r.id,
        projectId: r.projectId,
        categoryId: r.categoryId,
        name: r.name,
        summary: r.summary,
        contentJson: r.contentJson,
        tagIds: tagMap[r.id] ?? [],
        stageIds: [],
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
    }));
}




export function createBookElementSqliteRepository(projectId: string): ElementRepository {

    const findById = async (id: string): Promise<BookElement | null> => {
        const rows = await getDb().select()
            .from(BookElementTable)
            .where(eq(BookElementTable.id, id))
            .limit(1);

        if (rows.length === 0) return null;

        const mapped = await rowsToDomain(rows);
        return mapped[0] ?? null;
    };

    const findAll = async (): Promise<BookElement[]> => {
        const rows = await getDb().select()
            .from(BookElementTable)
            .where(eq(BookElementTable.projectId, projectId))
            .orderBy(desc(BookElementTable.updatedAt));

        return rowsToDomain(rows);
    };

    const findAllByCategory = async (categoryId: string): Promise<BookElement[]> => {
        const rows = await getDb().select()
            .from(BookElementTable)
            .where(and(
                eq(BookElementTable.projectId, projectId),
                eq(BookElementTable.categoryId, categoryId)
            ))
            .orderBy(desc(BookElementTable.updatedAt));

        return rowsToDomain(rows);
    };

    const findAllByTagId = async (tagId: string): Promise<BookElement[]> => {
        const rows = await getDb().select()
            .from(BookElementTable)
            .innerJoin(elementTagsLink, eq(BookElementTable.id, elementTagsLink.elementId))
            .where(and(
                eq(BookElementTable.projectId, projectId),
                eq(elementTagsLink.tagId, tagId)
            ))
            .orderBy(desc(BookElementTable.updatedAt));

        const elements = rows.map(r => r.element);
        return rowsToDomain(elements);
    };

    const create = async (input: BookElement): Promise<BookElement> => {

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

        await getDb().insert(BookElementTable).values(newElement);

        if (input.tagIds && input.tagIds.length > 0) {
            await setElementTagsLocal(input.id, input.tagIds);
        }

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

        await getDb().update(BookElementTable)
            .set(updateValues)
            .where(eq(BookElementTable.id, id));

        if (data.tagIds !== undefined) {
            await setElementTagsLocal(id, data.tagIds);
        }

        return findById(id);
    };

    const setElementTagsLocal = async (elementId: string, tags: string[]) => {
        await getDb().delete(elementTagsLink).where(eq(elementTagsLink.elementId, elementId));

        const now = new Date().toISOString();
        for (const tagName of tags) {
            let tagRow = (await getDb().select().from(ElementTagTable)
                .where(and(eq(ElementTagTable.projectId, projectId), eq(ElementTagTable.name, tagName)))
                .limit(1))[0];

            if (!tagRow) {
                const newId = uuidv7();
                tagRow = { id: newId, projectId, name: tagName, color: null, createdAt: now, updatedAt: now };
                await getDb().insert(ElementTagTable).values(tagRow);
            }

            await getDb().insert(elementTagsLink).values({
                elementId,
                tagId: tagRow.id,
            });
        }
    };

    return {
        findById,
        findAll,
        findAllByCategory,
        findAllByTagId,
        create,
        update,
        delete: async (id) => {
            await getDb().delete(BookElementTable).where(eq(BookElementTable.id, id));
            return true;
        },
        getElementTags: async (id) => {
            const map = await getTagMap([id]);
            return map[id] ?? [];
        },
        addElementTag: async (id, tag) => {
            await setElementTagsLocal(id, [...(await getTagMap([id]))[id] || [], tag]);
        },
        removeElementTag: async (id, tag) => {
            const current = (await getTagMap([id]))[id] || [];
            const next = current.filter(t => t !== tag);
            await setElementTagsLocal(id, next);
        },
        setElementTags: setElementTagsLocal,
    };
}
