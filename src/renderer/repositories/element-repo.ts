import { getDb } from '../lib/db';
import { BookElementTable, ElementCategoryTable, ElementTagTable, ElementTagLinkTable } from '../schema/drizzle';
import { eq, desc, and, inArray, getTableColumns, asc } from 'drizzle-orm';
import type { BookElement, BookElementCategory } from '../domain/book-element';
import { v7 as uuidv7 } from 'uuid';

const elementTagsLink = ElementTagLinkTable;

// Strict creation input
export type CreateBookElementInput = {
    // id: string;
    projectId: string;
    categoryId: string;
    name: string;
    summary: string;
    contentJson: string;
    stageIds: string[];
    tagIds: string[];
    // createdAt: string;
    // updatedAt: string;
};

export interface BookElementRepository {
    findById(id: string): Promise<BookElement | null>;
    findAll(): Promise<BookElement[]>;
    findAllByProject(projectId: string): Promise<BookElement[]>;
    findAllByCategory(projectId: string, categoryId: string): Promise<BookElement[]>;
    findAllByTag(projectId: string, tag: string): Promise<BookElement[]>;
    create(input: CreateBookElementInput): Promise<BookElement>;
    update(id: string, element: BookElement): Promise<BookElement | null>;
    delete(id: string): Promise<boolean>;

    setElementCategory(elementId: string, categoryName: string): Promise<void>;
    getElementCategory(elementId: string): Promise<string | null>;
    updateElementCategory(elementId: string, categoryName: string): Promise<void>;

    getElementTags(elementId: string): Promise<string[]>;
    addElementTag(elementId: string, tag: string): Promise<void>;
    removeElementTag(elementId: string, tag: string): Promise<void>;
    setElementTags(elementId: string, tags: string[]): Promise<void>;

    getElementContent(elementId: string): Promise<string>;
    setElementContent(elementId: string, content: string): Promise<void>;
}

export interface BookElementCategoryRepository {
    findAll(): Promise<BookElementCategory[]>;
    findByName(name: string): Promise<BookElementCategory | null>;
    create(name: string, color: string): Promise<BookElementCategory>;
    update(name: string, updates: { color?: string; description_json?: string }): Promise<BookElementCategory | null>;
    delete(name: string): Promise<boolean>;
}

const DEFAULT_CATEGORY_NAME = 'others';

function normalizeCategoryName(name?: string): string {
    const trimmed = name?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_CATEGORY_NAME;
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

async function mapToDomain(rows: { element: typeof BookElementTable.$inferSelect, categoryName: string | null }[]): Promise<BookElement[]> {
    const elementIds = rows.map(r => r.element.id);
    const tagMap = await getTagMap(elementIds);

    return rows.map(r => ({
        id: r.element.id,
        projectId: r.element.projectId,
        categoryId: r.categoryName ?? DEFAULT_CATEGORY_NAME, // Maps to name per legacy interface
        name: r.element.name,
        summary: r.element.summary ?? '',
        contentJson: r.element.contentJson ?? '{}',
        tagIds: tagMap[r.element.id] ?? [],
        stageIds: [], // TODO
        createdAt: r.element.createdAt,
        updatedAt: r.element.updatedAt,
    }));
}

export function createBookElementSqliteRepository(projectId: string): BookElementRepository {

    const findAll = async (): Promise<BookElement[]> => {
        const rows = await getDb().select()
            .from(BookElementTable)
            .leftJoin(ElementCategoryTable, eq(BookElementTable.categoryId, ElementCategoryTable.id))
            .where(eq(BookElementTable.projectId, projectId))
            .orderBy(desc(BookElementTable.updatedAt));

        // Map Drizzle result structure to my helper input
        const mappedInput = rows.map(r => ({
            element: r.elements,
            categoryName: r.element_categories?.name ?? null
        }));

        return mapToDomain(mappedInput);
    };

    const findAllByProject = async (pid: string): Promise<BookElement[]> => {
        const rows = await getDb().select()
            .from(BookElementTable)
            .leftJoin(ElementCategoryTable, eq(BookElementTable.categoryId, ElementCategoryTable.id))
            .where(eq(BookElementTable.projectId, pid))
            .orderBy(desc(BookElementTable.updatedAt));

        const mappedInput = rows.map(r => ({
            element: r.elements,
            categoryName: r.element_categories?.name ?? null
        }));
        return mapToDomain(mappedInput);
    };

    const findById = async (id: string): Promise<BookElement | null> => {
        const rows = await getDb().select()
            .from(BookElementTable)
            .leftJoin(ElementCategoryTable, eq(BookElementTable.categoryId, ElementCategoryTable.id))
            .where(eq(BookElementTable.id, id))
            .limit(1);

        if (rows.length === 0) return null;

        const mappedInput = rows.map(r => ({
            element: r.elements,
            categoryName: r.element_categories?.name ?? null
        }));
        const mapped = await mapToDomain(mappedInput);
        return mapped[0] ?? null;
    };

    const findAllByCategory = async (pid: string, categoryId: string): Promise<BookElement[]> => {
        const rows = await getDb().select()
            .from(BookElementTable)
            .leftJoin(ElementCategoryTable, eq(BookElementTable.categoryId, ElementCategoryTable.id))
            .where(and(
                eq(BookElementTable.projectId, pid),
                eq(ElementCategoryTable.id, categoryId)
            ))
            .orderBy(desc(BookElementTable.updatedAt));

        const mappedInput = rows.map(r => ({
            element: r.elements,
            categoryName: r.element_categories?.name ?? null
        }));
        return mapToDomain(mappedInput);
    };

    const findAllByTag = async (pid: string, tag: string): Promise<BookElement[]> => {
        const rows = await getDb().select()
            .from(BookElementTable)
            .leftJoin(ElementCategoryTable, eq(BookElementTable.categoryId, ElementCategoryTable.id))
            .innerJoin(elementTagsLink, eq(BookElementTable.id, elementTagsLink.elementId))
            .innerJoin(ElementTagTable, eq(elementTagsLink.tagId, ElementTagTable.id))
            .where(and(
                eq(BookElementTable.projectId, pid),
                eq(ElementTagTable.name, tag)
            ))
            .orderBy(desc(BookElementTable.updatedAt));

        const mappedInput = rows.map(r => ({
            element: r.elements,
            categoryName: r.element_categories?.name ?? null
        }));
        return mapToDomain(mappedInput);
    };

    const create = async (input: CreateBookElementInput): Promise<BookElement> => {
        const id = uuidv7();
        const now = new Date().toISOString();

        const newElement: typeof BookElementTable.$inferInsert = {
            id,
            projectId: input.projectId,
            categoryId: input.categoryId,
            name: input.name,
            summary: input.summary,
            contentJson: input.contentJson ?? '{}',
            createdAt: now,
            updatedAt: now,
        };

        await getDb().insert(BookElementTable).values(newElement);

        if (input.tagIds && input.tagIds.length > 0) {
            await setElementTagsLocal(id, input.tagIds);
        }

        return (await findById(id))!;
    };

    const update = async (id: string, element: BookElement): Promise<BookElement | null> => {
        const now = new Date().toISOString();

        await getDb().update(BookElementTable).set({
            categoryId: element.categoryId,
            name: element.name,
            summary: element.summary,
            contentJson: element.contentJson,
            updatedAt: now
        }).where(eq(BookElementTable.id, id));

        if (element.tagIds) {
            await setElementTagsLocal(id, element.tagIds);
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
        findAllByProject,
        findAllByCategory,
        findAllByTag,
        create,
        update,
        delete: async (id) => {
            await getDb().delete(BookElementTable).where(eq(BookElementTable.id, id));
            return true;
        },
        setElementCategory: async (id, catId) => {
            await getDb().update(BookElementTable).set({ categoryId: catId }).where(eq(BookElementTable.id, id));
        },
        getElementCategory: async (id) => {
            const r = await findById(id);
            return r?.categoryId ?? null;
        },
        updateElementCategory: async (id, catId) => {
            await getDb().update(BookElementTable).set({ categoryId: catId }).where(eq(BookElementTable.id, id));
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
        getElementContent: async (id) => {
            const r = await getDb().select({ c: BookElementTable.contentJson }).from(BookElementTable).where(eq(BookElementTable.id, id)).limit(1);
            return r[0]?.c ?? '{}';
        },
        setElementContent: async (id, c) => {
            await getDb().update(BookElementTable).set({ contentJson: c }).where(eq(BookElementTable.id, id));
        },
    };
}

export function createCategorySqliteRepository(projectId?: string): BookElementCategoryRepository {
    const withProjectCheck = (query: any) => {
        if (!projectId) return query;
        return query.where(eq(ElementCategoryTable.projectId, projectId));
    };

    return {
        findAll: async () => {
            let query = getDb().select().from(ElementCategoryTable);
            if (projectId) {
                query = query.where(eq(ElementCategoryTable.projectId, projectId));
            }
            const rows = await query.orderBy(asc(ElementCategoryTable.name));
            return rows.map(r => ({
                id: r.id,
                projectId: r.projectId,
                name: r.name,
                descriptionJson: r.descriptionJson ?? '{}',
                color: r.color ?? undefined,
                createdAt: r.createdAt,
                updatedAt: r.updatedAt,
            }));
        },
        findByName: async (name) => {
            const n = normalizeCategoryName(name);
            let query = getDb().select().from(ElementCategoryTable).where(eq(ElementCategoryTable.name, n));
             if (projectId) {
                query = query.where(eq(ElementCategoryTable.projectId, projectId));
            }
            const r = await query.limit(1);
            return r[0] ? {
                id: r[0].id,
                projectId: r[0].projectId,
                name: r[0].name,
                descriptionJson: r[0].descriptionJson ?? '{}',
                color: r[0].color ?? undefined,
                createdAt: r[0].createdAt,
                updatedAt: r[0].updatedAt,
            } : null;
        },
        create: async (name, color) => {
             // Missing implementation in original file? Assuming we want to Insert first.
            // But waiting, original only selected? That looks like a bug in original code context I read.
            // I will implement a proper create here.
             if (!projectId) throw new Error("ProjectId required for creation");

            const id = uuidv7();
            const now = new Date().toISOString();
            const n = normalizeCategoryName(name);

             await getDb().insert(ElementCategoryTable).values({
                id,
                projectId: projectId,
                name: n,
                color: color || '#888888',
                descriptionJson: '{}',
                createdAt: now,
                updatedAt: now
            });

            const r = (await getDb().select().from(ElementCategoryTable).where(eq(ElementCategoryTable.id, id)).limit(1))[0];
            return {
                id: r.id,
                projectId: r.projectId,
                name: r.name,
                descriptionJson: r.descriptionJson ?? '{}',
                color: r.color ?? undefined,
                createdAt: r.createdAt,
                updatedAt: r.updatedAt,
            };
        },
        update: async (name, updates) => {
            const n = normalizeCategoryName(name);
            let existingQuery = getDb().select({ id: ElementCategoryTable.id }).from(ElementCategoryTable).where(eq(ElementCategoryTable.name, n));
             if (projectId) {
                existingQuery = existingQuery.where(eq(ElementCategoryTable.projectId, projectId));
            }
            const existing = (await existingQuery.limit(1))[0];
            
            if (!existing) return null; // or throw

            const vals: any = {};
            if (updates.color) vals.color = updates.color;
            if (updates.description_json) vals.descriptionJson = updates.description_json;

            if (Object.keys(vals).length > 0) {
                await getDb().update(ElementCategoryTable).set(vals).where(eq(ElementCategoryTable.id, existing.id));
            }

            const r = (await getDb().select().from(ElementCategoryTable).where(eq(ElementCategoryTable.id, existing.id)).limit(1))[0];
            return {
                id: r.id,
                projectId: r.projectId,
                name: r.name,
                descriptionJson: r.descriptionJson ?? '{}',
                color: r.color ?? undefined,
                createdAt: r.createdAt,
                updatedAt: r.updatedAt,
            };
        },
        delete: async (name) => {
            const n = normalizeCategoryName(name);
            
            // Find target(s) based on context
            let targetQuery = getDb().select().from(ElementCategoryTable).where(eq(ElementCategoryTable.name, n));
            if (projectId) {
                targetQuery = targetQuery.where(eq(ElementCategoryTable.projectId, projectId));
            }
            
            const target = (await targetQuery.limit(1))[0];
            if (!target) return false;

            // Invariant check: need count of categories in this project
            const currentProjectId = target.projectId;
            const allCats = await getDb().select({ id: ElementCategoryTable.id }).from(ElementCategoryTable)
                .where(eq(ElementCategoryTable.projectId, currentProjectId));
            
            if (allCats.length <= 1) {
                throw new Error("Cannot delete the last category in the project.");
            }

            await getDb().delete(ElementCategoryTable).where(eq(ElementCategoryTable.id, target.id));
            return true;
        },
    };
}
