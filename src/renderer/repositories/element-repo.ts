import { getDb } from '../lib/db';
import { elements, elementCategories, elementTags, elementTagsLink } from '../schema/drizzle';
import { eq, desc, and, inArray, getTableColumns, asc } from 'drizzle-orm';
import type { BookElement, BookElementCategory } from '../domain/book-element';
import { v7 as uuidv7 } from 'uuid';


// Strict creation input
export type CreateBookElementInput = {
    projectId: string;
    categoryName: string; // Explicitly name, because usage resolves it to ID
    // The previous implementation took full BookElement which has categoryId AND used ensureCategoryId(element.categoryId).
    // Let's pass categoryId/Name as strict input.
    name: string;
    summary?: string;
    contentJson?: string;
    tagIds?: string[];
};

export interface BookElementRepository {
    findById(id: string): Promise<BookElement | null>;
    findAll(): Promise<BookElement[]>;
    findAllByProject(projectId: string): Promise<BookElement[]>;
    findAllByCategory(projectId: string, category: string): Promise<BookElement[]>;
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
    create(name: string, color?: string): Promise<BookElementCategory>;
    update(name: string, updates: { color?: string; description_json?: string }): Promise<BookElementCategory | null>;
    delete(name: string): Promise<boolean>;
    ensureCategory(name: string): Promise<void>;
}

const DEFAULT_CATEGORY_NAME = 'others';

function normalizeCategoryName(name?: string): string {
    const trimmed = name?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_CATEGORY_NAME;
}

// Helpers
async function ensureCategoryId(name: string): Promise<string> {
    const normalized = normalizeCategoryName(name);
    const existing = await getDb().select().from(elementCategories).where(eq(elementCategories.name, normalized)).limit(1);
    if (existing[0]) return existing[0].id;

    const newId = uuidv7();
    await getDb().insert(elementCategories).values({
        id: newId,
        name: normalized,
        descriptionJson: '{}',
        color: '#CCCCCC',
    });
    return newId;
}

async function getTagMap(elementIds: string[]): Promise<Record<string, string[]>> {
    if (!elementIds.length) return {};

    const rows = await getDb().select({
        elementId: elementTagsLink.elementId,
        tagName: elementTags.name
    })
        .from(elementTagsLink)
        .innerJoin(elementTags, eq(elementTagsLink.tagId, elementTags.id))
        .where(inArray(elementTagsLink.elementId, elementIds));

    const map: Record<string, string[]> = {};
    for (const r of rows) {
        if (!map[r.elementId]) map[r.elementId] = [];
        map[r.elementId].push(r.tagName);
    }
    return map;
}

async function mapToDomain(rows: { element: typeof elements.$inferSelect, categoryName: string | null }[]): Promise<BookElement[]> {
    const elementIds = rows.map(r => r.element.id);
    const tagMap = await getTagMap(elementIds);

    return rows.map(r => ({
        id: r.element.id,
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
            .from(elements)
            .leftJoin(elementCategories, eq(elements.categoryId, elementCategories.id))
            .where(eq(elements.projectId, projectId))
            .orderBy(desc(elements.updatedAt));

        // Map Drizzle result structure to my helper input
        const mappedInput = rows.map(r => ({
            element: r.elements,
            categoryName: r.element_categories?.name ?? null
        }));

        return mapToDomain(mappedInput);
    };

    const findAllByProject = async (pid: string): Promise<BookElement[]> => {
        const rows = await getDb().select()
            .from(elements)
            .leftJoin(elementCategories, eq(elements.categoryId, elementCategories.id))
            .where(eq(elements.projectId, pid))
            .orderBy(desc(elements.updatedAt));

        const mappedInput = rows.map(r => ({
            element: r.elements,
            categoryName: r.element_categories?.name ?? null
        }));
        return mapToDomain(mappedInput);
    };

    const findById = async (id: string): Promise<BookElement | null> => {
        const rows = await getDb().select()
            .from(elements)
            .leftJoin(elementCategories, eq(elements.categoryId, elementCategories.id))
            .where(eq(elements.id, id))
            .limit(1);

        if (rows.length === 0) return null;

        const mappedInput = rows.map(r => ({
            element: r.elements,
            categoryName: r.element_categories?.name ?? null
        }));
        const mapped = await mapToDomain(mappedInput);
        return mapped[0] ?? null;
    };

    const findAllByCategory = async (pid: string, category: string): Promise<BookElement[]> => {
        const normalized = normalizeCategoryName(category);
        const rows = await getDb().select()
            .from(elements)
            .leftJoin(elementCategories, eq(elements.categoryId, elementCategories.id))
            .where(and(
                eq(elements.projectId, pid),
                eq(elementCategories.name, normalized)
            ))
            .orderBy(desc(elements.updatedAt));

        const mappedInput = rows.map(r => ({
            element: r.elements,
            categoryName: r.element_categories?.name ?? null
        }));
        return mapToDomain(mappedInput);
    };

    const findAllByTag = async (pid: string, tag: string): Promise<BookElement[]> => {
        const rows = await getDb().select()
            .from(elements)
            .leftJoin(elementCategories, eq(elements.categoryId, elementCategories.id))
            .innerJoin(elementTagsLink, eq(elements.id, elementTagsLink.elementId))
            .innerJoin(elementTags, eq(elementTagsLink.tagId, elementTags.id))
            .where(and(
                eq(elements.projectId, pid),
                eq(elementTags.name, tag)
            ))
            .orderBy(desc(elements.updatedAt));

        const mappedInput = rows.map(r => ({
            element: r.elements,
            categoryName: r.element_categories?.name ?? null
        }));
        return mapToDomain(mappedInput);
    };

    const create = async (input: CreateBookElementInput): Promise<BookElement> => {
        const categoryId = await ensureCategoryId(input.categoryName);
        const id = uuidv7();
        const now = new Date().toISOString();

        const newElement: typeof elements.$inferInsert = {
            id,
            projectId: projectId,
            categoryId: categoryId,
            name: input.name,
            summary: input.summary,
            contentJson: input.contentJson ?? '{}',
            createdAt: now,
            updatedAt: now,
        };

        await getDb().insert(elements).values(newElement);

        if (input.tagIds && input.tagIds.length > 0) {
            await setElementTagsLocal(id, input.tagIds);
        }

        return (await findById(id))!;
    };

    const update = async (id: string, element: BookElement): Promise<BookElement | null> => {
        const categoryId = await ensureCategoryId(element.categoryId);
        const now = new Date().toISOString();

        await getDb().update(elements).set({
            categoryId,
            name: element.name,
            summary: element.summary,
            contentJson: element.contentJson,
            updatedAt: now
        }).where(eq(elements.id, id));

        if (element.tagIds) {
            await setElementTagsLocal(id, element.tagIds);
        }

        return findById(id);
    };

    const setElementTagsLocal = async (elementId: string, tags: string[]) => {
        await getDb().delete(elementTagsLink).where(eq(elementTagsLink.elementId, elementId));

        const now = new Date().toISOString();
        for (const tagName of tags) {
            let tagRow = (await getDb().select().from(elementTags)
                .where(and(eq(elementTags.projectId, projectId), eq(elementTags.name, tagName)))
                .limit(1))[0];

            if (!tagRow) {
                const newId = uuidv7();
                tagRow = { id: newId, projectId, name: tagName, color: null, createdAt: now };
                await getDb().insert(elementTags).values(tagRow);
            }

            await getDb().insert(elementTagsLink).values({
                elementId,
                tagId: tagRow.id,
                createdAt: now
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
            await getDb().delete(elements).where(eq(elements.id, id));
            return true;
        },
        setElementCategory: async (id, catName) => {
            const catId = await ensureCategoryId(catName);
            await getDb().update(elements).set({ categoryId: catId }).where(eq(elements.id, id));
        },
        getElementCategory: async (id) => {
            const r = await findById(id);
            return r?.categoryId ?? null;
        },
        updateElementCategory: async (id, catName) => {
            const catId = await ensureCategoryId(catName);
            await getDb().update(elements).set({ categoryId: catId }).where(eq(elements.id, id));
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
            const r = await getDb().select({ c: elements.contentJson }).from(elements).where(eq(elements.id, id)).limit(1);
            return r[0]?.c ?? '{}';
        },
        setElementContent: async (id, c) => {
            await getDb().update(elements).set({ contentJson: c }).where(eq(elements.id, id));
        },
    };
}

export function createCategorySqliteRepository(): BookElementCategoryRepository {
    return {
        findAll: async () => {
            const rows = await getDb().select().from(elementCategories).orderBy(asc(elementCategories.name));
            return rows.map(r => ({
                id: r.id,
                name: r.name,
                descriptionJson: r.descriptionJson ?? '{}',
                color: r.color ?? undefined
            }));
        },
        findByName: async (name) => {
            const n = normalizeCategoryName(name);
            const r = await getDb().select().from(elementCategories).where(eq(elementCategories.name, n)).limit(1);
            return r[0] ? { id: r[0].id, name: r[0].name, descriptionJson: r[0].descriptionJson ?? '{}', color: r[0].color ?? undefined } : null;
        },
        create: async (name, color) => {
            const id = await ensureCategoryId(name);
            if (color) {
                await getDb().update(elementCategories).set({ color }).where(eq(elementCategories.id, id));
            }
            const r = (await getDb().select().from(elementCategories).where(eq(elementCategories.id, id)).limit(1))[0];
            return { id: r.id, name: r.name, descriptionJson: r.descriptionJson ?? '{}', color: r.color ?? undefined };
        },
        update: async (name, updates) => {
            const n = normalizeCategoryName(name);
            const existing = (await getDb().select({ id: elementCategories.id }).from(elementCategories).where(eq(elementCategories.name, n)).limit(1))[0];
            if (!existing) return null;

            const vals: any = {};
            if (updates.color) vals.color = updates.color;
            if (updates.description_json) vals.descriptionJson = updates.description_json;

            if (Object.keys(vals).length > 0) {
                await getDb().update(elementCategories).set(vals).where(eq(elementCategories.id, existing.id));
            }

            const r = (await getDb().select().from(elementCategories).where(eq(elementCategories.id, existing.id)).limit(1))[0];
            return { id: r.id, name: r.name, descriptionJson: r.descriptionJson ?? '{}', color: r.color ?? undefined };
        },
        delete: async (name) => {
            const n = normalizeCategoryName(name);
            await getDb().delete(elementCategories).where(eq(elementCategories.name, n));
            return true;
        },
        ensureCategory: async (name) => {
            await ensureCategoryId(name);
        }
    };
}

// Sync related functions (placeholders)
export async function markElementSyncStatus() { }
export async function markElementCategorySyncStatus() { }
export async function cleanupSyncedDeletedElements() { }
export async function cleanupSyncedDeletedCategories() { }
export async function applyRemoteElement() { return 'skipped'; }
export async function applyRemoteElementCategory() { return 'skipped'; }
