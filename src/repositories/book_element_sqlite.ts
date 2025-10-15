import type { BookElement, BookElementCategory } from '../domain/book_element';
import type { ElementRecord, ElementCategoryRecord } from '../schema/book_element';
import type { BookElementRepository, BookElementCategoryRepository } from './book_element';
import { run, query } from '../lib/db';

const esc = (v: string) => v.replaceAll("'", "''");

const DEFAULT_CATEGORY_NAME = 'others';
const DEFAULT_ELEMENT_TYPE = 'generic';

type ElementRow = ElementRecord & { category_name: string | null };

const toCategoryDomain = (row: ElementCategoryRecord): BookElementCategory => ({
    id: row.id,
    name: row.name,
    description_json: row.description_json,
    color: row.color ?? undefined,
});

const normalizeCategoryName = (name?: string): string => {
    const trimmed = name?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_CATEGORY_NAME;
};

const toDomain = (row: ElementRow, tags: string[]): BookElement => ({
    id: row.id,
    category: row.category_name ?? DEFAULT_CATEGORY_NAME,
    name: row.name,
    tags,
    content_json: row.content_json,
    summary_json: row.summary_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stages: [],
});

async function fetchTagMap(elementIds: string[]): Promise<Record<string, string[]>> {
    if (!elementIds.length) return {};
    const uniqueIds = Array.from(new Set(elementIds));
    const inClause = uniqueIds.map(id => `'${esc(id)}'`).join(',');
    const rows = await query<{ element_id: string; name: string }>(
        `SELECT element_id, name FROM element_tag WHERE element_id IN (${inClause})`
    );
    const map: Record<string, string[]> = {};
    for (const row of rows) {
        if (!map[row.element_id]) map[row.element_id] = [];
        map[row.element_id].push(row.name);
    }
    return map;
}

async function mapRowsToDomain(rows: ElementRow[]): Promise<BookElement[]> {
    if (!rows.length) return [];
    const tagMap = await fetchTagMap(rows.map(row => row.id));
    return rows.map(row => toDomain(row, tagMap[row.id] ?? []));
}

async function ensureCategoryId(categoryName: string): Promise<string> {
    const normalized = normalizeCategoryName(categoryName);
    const existing = await query<{ id: string }>(
        `SELECT id FROM element_category WHERE name='${esc(normalized)}' LIMIT 1`
    );
    if (existing[0]) return existing[0].id;
    const newId = crypto.randomUUID();
    await run(
        `INSERT OR IGNORE INTO element_category (id, name, description_json, color)
         VALUES ('${esc(newId)}','${esc(normalized)}','{}', NULL)`
    );
    const rows = await query<{ id: string }>(
        `SELECT id FROM element_category WHERE name='${esc(normalized)}' LIMIT 1`
    );
    return rows[0]?.id ?? newId;
}

async function replaceTags(elementId: string, tags: string[]): Promise<void> {
    await run(`DELETE FROM element_tag WHERE element_id='${esc(elementId)}'`);
    if (!tags.length) return;
    const now = new Date().toISOString();
    for (const tag of tags) {
        await run(
            `INSERT INTO element_tag (id, element_id, name, created_at)
             VALUES ('${esc(crypto.randomUUID())}','${esc(elementId)}','${esc(tag)}','${esc(now)}')`
        );
    }
}

export function createBookElementSqliteRepository(projectId: string): BookElementRepository {
    const selectBase = `SELECT e.*, c.name AS category_name
        FROM element e
        LEFT JOIN element_category c ON e.category_id = c.id`;

    const findById = async (id: string): Promise<BookElement | null> => {
        const rows = await query<ElementRow>(`${selectBase} WHERE e.id='${esc(id)}' LIMIT 1`);
        const mapped = await mapRowsToDomain(rows);
        return mapped[0] ?? null;
    };

    const findAll = async (): Promise<BookElement[]> => {
        const rows = await query<ElementRow>(
            `${selectBase} WHERE e.project_id='${esc(projectId)}' ORDER BY e.updated_at DESC`
        );
        return mapRowsToDomain(rows);
    };

    const findAllByProject = async (pid: string): Promise<BookElement[]> => {
        const rows = await query<ElementRow>(
            `${selectBase} WHERE e.project_id='${esc(pid)}' ORDER BY e.updated_at DESC`
        );
        return mapRowsToDomain(rows);
    };

    const findAllByCategory = async (pid: string, category: string): Promise<BookElement[]> => {
        const normalized = normalizeCategoryName(category);
        const rows = await query<ElementRow>(
            `${selectBase} WHERE e.project_id='${esc(pid)}' AND c.name='${esc(normalized)}'
             ORDER BY e.updated_at DESC`
        );
        return mapRowsToDomain(rows);
    };

    const findAllByTag = async (pid: string, tag: string): Promise<BookElement[]> => {
        const rows = await query<ElementRow>(
            `${selectBase}
             JOIN element_tag t ON e.id = t.element_id
             WHERE e.project_id='${esc(pid)}' AND t.name='${esc(tag)}'
             ORDER BY e.updated_at DESC`
        );
        return mapRowsToDomain(rows);
    };

    const create = async (element: BookElement): Promise<BookElement> => {
        const normalizedCategory = normalizeCategoryName(element.category);
        const categoryId = await ensureCategoryId(normalizedCategory);
        const createdAt = element.createdAt ?? new Date().toISOString();
        const updatedAt = element.updatedAt ?? createdAt;
        await run(
            `INSERT INTO element (id, project_id, category_id, type, name, content_json, summary_json, created_at, updated_at)
             VALUES ('${esc(element.id)}','${esc(projectId)}','${esc(categoryId)}','${esc(DEFAULT_ELEMENT_TYPE)}',
                     '${esc(element.name)}','${esc(element.content_json ?? '{}')}','${esc(element.summary_json ?? '{}')}',
                     '${esc(createdAt)}','${esc(updatedAt)}')`
        );
        await replaceTags(element.id, element.tags ?? []);
        const persisted = await findById(element.id);
        if (!persisted) throw new Error('Failed to load element after creation');
        return persisted;
    };

    const update = async (id: string, element: BookElement): Promise<BookElement | null> => {
        const existing = await findById(id);
        if (!existing) return null;
        const normalizedCategory = normalizeCategoryName(element.category);
        const categoryId = await ensureCategoryId(normalizedCategory);
        const updatedAt = element.updatedAt ?? new Date().toISOString();
        await run(
            `UPDATE element SET
                category_id='${esc(categoryId)}',
                name='${esc(element.name)}',
                content_json='${esc(element.content_json ?? '{}')}',
                summary_json='${esc(element.summary_json ?? '{}')}',
                updated_at='${esc(updatedAt)}'
             WHERE id='${esc(id)}'`
        );
        await replaceTags(id, element.tags ?? existing.tags ?? []);
        return findById(id);
    };

    const remove = async (id: string): Promise<boolean> => {
        await run(`DELETE FROM element WHERE id='${esc(id)}'`);
        return true;
    };

    const setElementCategory = async (elementId: string, categoryName: string): Promise<void> => {
        await updateElementCategory(elementId, categoryName);
    };

    const getElementCategory = async (elementId: string): Promise<string | null> => {
        const rows = await query<{ name: string | null }>(
            `SELECT c.name FROM element e
             LEFT JOIN element_category c ON e.category_id = c.id
             WHERE e.id='${esc(elementId)}' LIMIT 1`
        );
        return rows[0]?.name ?? null;
    };

    const updateElementCategory = async (elementId: string, categoryName: string): Promise<void> => {
        const categoryId = await ensureCategoryId(categoryName);
        await run(`UPDATE element SET category_id='${esc(categoryId)}' WHERE id='${esc(elementId)}'`);
    };

    const getElementTags = async (elementId: string): Promise<string[]> => {
        const map = await fetchTagMap([elementId]);
        return map[elementId] ?? [];
    };

    const addElementTag = async (elementId: string, tag: string): Promise<void> => {
        await run(
            `INSERT OR IGNORE INTO element_tag (id, element_id, name, created_at)
             VALUES ('${esc(crypto.randomUUID())}','${esc(elementId)}','${esc(tag)}','${esc(new Date().toISOString())}')`
        );
    };

    const removeElementTag = async (elementId: string, tag: string): Promise<void> => {
        await run(`DELETE FROM element_tag WHERE element_id='${esc(elementId)}' AND name='${esc(tag)}'`);
    };

    const setElementTags = async (elementId: string, tags: string[]): Promise<void> => {
        await replaceTags(elementId, tags);
    };

    const getElementContent = async (elementId: string): Promise<string> => {
        const rows = await query<{ content_json: string }>(
            `SELECT content_json FROM element WHERE id='${esc(elementId)}' LIMIT 1`
        );
        return rows[0]?.content_json ?? '{}';
    };

    const setElementContent = async (elementId: string, content: string): Promise<void> => {
        await run(
            `UPDATE element SET content_json='${esc(content)}', updated_at='${esc(new Date().toISOString())}'
             WHERE id='${esc(elementId)}'`
        );
    };

    return {
        findById,
        findAll,
        findAllByProject,
        findAllByCategory,
        findAllByTag,
        create,
        update,
        delete: remove,
        setElementCategory,
        getElementCategory,
        updateElementCategory,
        getElementTags,
        addElementTag,
        removeElementTag,
        setElementTags,
        getElementContent,
        setElementContent,
    };
}

export function createCategorySqliteRepository(): BookElementCategoryRepository {
    const findByNameInternal = async (name: string): Promise<BookElementCategory | null> => {
        const normalized = normalizeCategoryName(name);
        const rows = await query<ElementCategoryRecord>(
            `SELECT * FROM element_category WHERE name='${esc(normalized)}' LIMIT 1`
        );
        const record = rows[0];
        return record ? toCategoryDomain(record) : null;
    };

    return {
        async findAll(): Promise<BookElementCategory[]> {
            const rows = await query<ElementCategoryRecord>(`SELECT * FROM element_category ORDER BY name ASC`);
            return rows.map(toCategoryDomain);
        },
        findByName: findByNameInternal,
        async create(name: string, color?: string): Promise<BookElementCategory> {
            const normalized = normalizeCategoryName(name);
            const rec: ElementCategoryRecord = {
                id: crypto.randomUUID(),
                name: normalized,
                description_json: JSON.stringify({ description: '' }),
                color,
            };
            await run(
                `INSERT INTO element_category (id, name, description_json, color)
                 VALUES ('${esc(rec.id)}','${esc(rec.name)}','${esc(rec.description_json)}',${color ? `'${esc(color)}'` : 'NULL'})`
            );
            return toCategoryDomain(rec);
        },
        async update(name: string, color: string): Promise<BookElementCategory | null> {
            const normalized = normalizeCategoryName(name);
            await run(`UPDATE element_category SET color='${esc(color)}' WHERE name='${esc(normalized)}'`);
            return findByNameInternal(normalized);
        },
        async delete(name: string): Promise<boolean> {
            const normalized = normalizeCategoryName(name);
            await run(`DELETE FROM element_category WHERE name='${esc(normalized)}'`);
            return true;
        },
        async ensureCategory(name: string): Promise<void> {
            const normalized = normalizeCategoryName(name);
            await run(
                `INSERT OR IGNORE INTO element_category (id, name, description_json, color)
                 VALUES ('${esc(crypto.randomUUID())}','${esc(normalized)}','{}', NULL)`
            );
        }
    };
}
