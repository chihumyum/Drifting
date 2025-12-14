import type { BookElement, BookElementCategory } from '../domain/book_element';
import type { ElementRecord, ElementCategoryRecord } from '../schema/book_element';
import type { BookElementRepository, BookElementCategoryRepository } from './book_element';
import { run, query } from '../lib/db';
import { syncManager } from '../lib/sync/sync-manager';
import { useAuthStore } from '../store/auth';

const esc = (v: string) => v.replaceAll("'", "''");

const canSync = () => {
    const { isAuthenticated } = useAuthStore.getState();
    return isAuthenticated && navigator.onLine;
};

const DEFAULT_CATEGORY_NAME = 'others';
const DEFAULT_ELEMENT_TYPE = 'generic';

type SyncStatus = 'synced' | 'pending' | 'syncing' | 'failed';

interface SyncMetadata {
  syncStatus: SyncStatus;
  lastModified: number;
  isDeleted: number;
}

const ensureSyncMetadata = (metadata?: Partial<SyncMetadata>): SyncMetadata => ({
  syncStatus: metadata?.syncStatus ?? 'synced',
  lastModified: metadata?.lastModified ?? Date.now(),
  isDeleted: metadata?.isDeleted ?? 0,
});

type ElementRow = ElementRecord & { category_name: string | null };

const ensureElementRecord = (
    record: ElementRecord,
): ElementRecord & Required<Pick<ElementRecord, 'sync_status' | 'last_modified' | 'is_deleted'>> => ({
    ...record,
    sync_status: record.sync_status ?? 'synced',
    last_modified: record.last_modified ?? (Date.parse(record.updated_at) || Date.now()),
    is_deleted: record.is_deleted ?? 0,
});

const ensureCategoryRecord = (
    record: ElementCategoryRecord,
): ElementCategoryRecord & Required<Pick<ElementCategoryRecord, 'sync_status' | 'last_modified' | 'is_deleted'>> => ({
    ...record,
    sync_status: record.sync_status ?? 'synced',
    last_modified: record.last_modified ?? Date.now(),
    is_deleted: record.is_deleted ?? 0,
});

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

const getElementRecordById = async (id: string) => {
    const rows = await query<ElementRecord & { sync_status?: SyncStatus; last_modified?: number | null; is_deleted?: number }>(
        `SELECT * FROM element WHERE id='${esc(id)}' LIMIT 1`
    );
    return rows[0] ? ensureElementRecord(rows[0]) : undefined;
};

const insertElementRecord = async (record: ElementRecord, metadata?: Partial<SyncMetadata>) => {
    const sync = ensureSyncMetadata(metadata);
    await run(
        `INSERT INTO element (id, project_id, category_id, type, name, content_json, summary_json, created_at, updated_at, sync_status, last_modified, is_deleted)
         VALUES ('${esc(record.id)}','${esc(record.project_id)}',${record.category_id ? `'${esc(record.category_id)}'` : 'NULL'},'${esc(record.type)}','${esc(record.name)}','${esc(record.content_json)}','${esc(record.summary_json)}','${esc(record.created_at)}','${esc(record.updated_at)}','${sync.syncStatus}',${sync.lastModified},${sync.isDeleted})`
    );
};

const updateElementRecord = async (record: ElementRecord, metadata?: Partial<SyncMetadata>) => {
    const sync = ensureSyncMetadata(metadata);
    await run(
        `UPDATE element SET
            project_id='${esc(record.project_id)}',
            category_id=${record.category_id ? `'${esc(record.category_id)}'` : 'NULL'},
            type='${esc(record.type)}',
            name='${esc(record.name)}',
            content_json='${esc(record.content_json)}',
            summary_json='${esc(record.summary_json)}',
            created_at='${esc(record.created_at)}',
            updated_at='${esc(record.updated_at)}',
            sync_status='${sync.syncStatus}',
            last_modified=${sync.lastModified},
            is_deleted=${sync.isDeleted}
         WHERE id='${esc(record.id)}'`
    );
};

const getCategoryRecordById = async (id: string) => {
    const rows = await query<ElementCategoryRecord & { sync_status?: SyncStatus; last_modified?: number | null; is_deleted?: number }>(
        `SELECT * FROM element_category WHERE id='${esc(id)}' LIMIT 1`
    );
    return rows[0] ? ensureCategoryRecord(rows[0]) : undefined;
};

const getCategoryRecordByName = async (name: string) => {
    const rows = await query<ElementCategoryRecord & { sync_status?: SyncStatus; last_modified?: number | null; is_deleted?: number }>(
        `SELECT * FROM element_category WHERE name='${esc(name)}' LIMIT 1`
    );
    return rows[0] ? ensureCategoryRecord(rows[0]) : undefined;
};

const insertCategoryRecord = async (record: ElementCategoryRecord, metadata?: Partial<SyncMetadata>) => {
    const sync = ensureSyncMetadata(metadata);
    await run(
        `INSERT INTO element_category (id, name, description_json, color, sync_status, last_modified, is_deleted)
         VALUES ('${esc(record.id)}','${esc(record.name)}','${esc(record.description_json)}',${record.color ? `'${esc(record.color)}'` : 'NULL'},'${sync.syncStatus}',${sync.lastModified},${sync.isDeleted})`
    );
};

const updateCategoryRecord = async (record: ElementCategoryRecord, metadata?: Partial<SyncMetadata>) => {
    const sync = ensureSyncMetadata(metadata);
    await run(
        `UPDATE element_category SET
            name='${esc(record.name)}',
            description_json='${esc(record.description_json)}',
            color=${record.color ? `'${esc(record.color)}'` : 'NULL'},
            sync_status='${sync.syncStatus}',
            last_modified=${sync.lastModified},
            is_deleted=${sync.isDeleted}
         WHERE id='${esc(record.id)}'`
    );
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
    const existing = await getCategoryRecordByName(normalized);
    const lastModified = Date.now();

    if (existing) {
        await updateCategoryRecord(
            {
                id: existing.id,
                name: normalized,
                description_json: existing.description_json ?? '{}',
                color: existing.color ?? null,
                sync_status: existing.sync_status,
                last_modified: existing.last_modified,
                is_deleted: 0,
            },
            { syncStatus: 'pending', lastModified, isDeleted: 0 }
        );
        return existing.id;
    }

    const newId = crypto.randomUUID();
    await insertCategoryRecord(
        {
            id: newId,
            name: normalized,
            description_json: '{}',
            color: undefined,
            sync_status: 'pending',
            last_modified: lastModified,
            is_deleted: 0,
        },
        { syncStatus: 'pending', lastModified, isDeleted: 0 }
    );

    return newId;
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
        const rows = await query<ElementRow>(
            `${selectBase} WHERE e.id='${esc(id)}' AND e.is_deleted = 0 LIMIT 1`
        );
        const mapped = await mapRowsToDomain(rows);
        return mapped[0] ?? null;
    };

    const findAll = async (): Promise<BookElement[]> => {
        const rows = await query<ElementRow>(
            `${selectBase} WHERE e.project_id='${esc(projectId)}' AND e.is_deleted = 0 ORDER BY e.updated_at DESC`
        );
        return mapRowsToDomain(rows);
    };

    const findAllByProject = async (pid: string): Promise<BookElement[]> => {
        const rows = await query<ElementRow>(
            `${selectBase} WHERE e.project_id='${esc(pid)}' AND e.is_deleted = 0 ORDER BY e.updated_at DESC`
        );
        return mapRowsToDomain(rows);
    };

    const findAllByCategory = async (pid: string, category: string): Promise<BookElement[]> => {
        const normalized = normalizeCategoryName(category);
        const rows = await query<ElementRow>(
            `${selectBase} WHERE e.project_id='${esc(pid)}' AND e.is_deleted = 0 AND c.name='${esc(normalized)}'
             ORDER BY e.updated_at DESC`
        );
        return mapRowsToDomain(rows);
    };

    const findAllByTag = async (pid: string, tag: string): Promise<BookElement[]> => {
        const rows = await query<ElementRow>(
            `${selectBase}
             JOIN element_tag t ON e.id = t.element_id
             WHERE e.project_id='${esc(pid)}' AND e.is_deleted = 0 AND t.name='${esc(tag)}'
             ORDER BY e.updated_at DESC`
        );
        return mapRowsToDomain(rows);
    };

    const create = async (element: BookElement): Promise<BookElement> => {
        const normalizedCategory = normalizeCategoryName(element.category);
        const categoryId = await ensureCategoryId(normalizedCategory);
        const createdAt = element.createdAt ?? new Date().toISOString();
        const updatedAt = element.updatedAt ?? createdAt;
        const lastModified = Date.now();
        const record: ElementRecord = {
            id: element.id,
            project_id: projectId,
            category_id: categoryId,
            type: DEFAULT_ELEMENT_TYPE,
            name: element.name,
            content_json: element.content_json ?? '{}',
            summary_json: element.summary_json ?? '{}',
            created_at: createdAt,
            updated_at: updatedAt,
            sync_status: 'pending',
            last_modified: lastModified,
            is_deleted: 0,
        };

        await insertElementRecord(record, { syncStatus: 'pending', lastModified, isDeleted: 0 });
        await replaceTags(element.id, element.tags ?? []);

        if (canSync()) {
            syncManager.enqueue({
                type: 'create',
                entity: 'element',
                localId: element.id,
                projectId,
                data: {
                    id: element.id,
                    name: element.name,
                    categoryName: normalizedCategory,
                    description: (() => {
                        try {
                            const parsed = element.summary_json ? JSON.parse(element.summary_json) : undefined;
                            return typeof parsed?.description === 'string' ? parsed.description : undefined;
                        } catch {
                            return undefined;
                        }
                    })(),
                    metadata: (() => {
                        try {
                            return element.content_json ? JSON.parse(element.content_json) : undefined;
                        } catch {
                            return undefined;
                        }
                    })(),
                },
                priority: 'normal',
            });
        }
        const persisted = await findById(element.id);
        if (!persisted) throw new Error('Failed to load element after creation');
        return persisted;
    };

    const update = async (id: string, element: BookElement): Promise<BookElement | null> => {
        const existing = await findById(id);
        if (!existing) return null;
        const existingRecord = await getElementRecordById(id);
        if (!existingRecord) return null;

        const normalizedCategory = normalizeCategoryName(element.category);
        const categoryId = await ensureCategoryId(normalizedCategory);
        const updatedAt = element.updatedAt ?? new Date().toISOString();
        const lastModified = Date.now();

        const record: ElementRecord = {
            id,
            project_id: existingRecord.project_id,
            category_id: categoryId,
            type: existingRecord.type ?? DEFAULT_ELEMENT_TYPE,
            name: element.name ?? existing.name,
            content_json: element.content_json ?? existing.content_json ?? existingRecord.content_json,
            summary_json: element.summary_json ?? existing.summary_json ?? existingRecord.summary_json,
            created_at: existingRecord.created_at,
            updated_at: updatedAt,
        };

        await updateElementRecord(record, { syncStatus: 'pending', lastModified, isDeleted: 0 });
        await replaceTags(id, element.tags ?? existing.tags ?? []);

        if (canSync()) {
            syncManager.enqueue({
                type: 'update',
                entity: 'element',
                localId: id,
                projectId,
                data: {
                    name: element.name,
                    categoryName: normalizedCategory,
                    description: (() => {
                        try {
                            const parsed = element.summary_json ? JSON.parse(element.summary_json) : undefined;
                            return typeof parsed?.description === 'string' ? parsed.description : undefined;
                        } catch {
                            return undefined;
                        }
                    })(),
                    metadata: (() => {
                        try {
                            return element.content_json ? JSON.parse(element.content_json) : undefined;
                        } catch {
                            return undefined;
                        }
                    })(),
                },
                priority: 'normal',
            });
        }
        return findById(id);
    };

    const remove = async (id: string): Promise<boolean> => {
        const now = new Date().toISOString();
        const lastModified = Date.now();
        await run(
            `UPDATE element SET is_deleted = 1, sync_status = 'pending', last_modified = ${lastModified}, updated_at='${esc(now)}' WHERE id='${esc(id)}'`
        );

        if (canSync()) {
            syncManager.enqueue({
                type: 'delete',
                entity: 'element',
                localId: id,
                projectId,
                priority: 'normal',
            });
        }
        return true;
    };

    const setElementCategory = async (elementId: string, categoryName: string): Promise<void> => {
        await updateElementCategory(elementId, categoryName);
    };

    const getElementCategory = async (elementId: string): Promise<string | null> => {
        const rows = await query<{ name: string | null }>(
            `SELECT c.name FROM element e
             LEFT JOIN element_category c ON e.category_id = c.id
             WHERE e.id='${esc(elementId)}' AND e.is_deleted = 0 AND (c.is_deleted = 0 OR c.is_deleted IS NULL) LIMIT 1`
        );
        return rows[0]?.name ?? null;
    };

    const updateElementCategory = async (elementId: string, categoryName: string): Promise<void> => {
        const categoryId = await ensureCategoryId(categoryName);
        const now = new Date().toISOString();
        const lastModified = Date.now();
        await run(
            `UPDATE element SET category_id='${esc(categoryId)}', sync_status='pending', last_modified=${lastModified}, updated_at='${esc(now)}' WHERE id='${esc(elementId)}'`
        );
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

export interface RemoteElementPayload {
    id: string;
    projectId: string;
    name: string;
    categoryId?: string | null;
    categoryName?: string | null;
    type?: string | null;
    contentJson?: string | null;
    summaryJson?: string | null;
    tags?: string[];
    createdAt: string;
    updatedAt: string;
    isDeleted?: boolean;
}

export interface RemoteElementCategoryPayload {
    id: string;
    name: string;
    descriptionJson?: string | null;
    color?: string | null;
    updatedAt: string;
    isDeleted?: boolean;
}

export async function markElementSyncStatus(
    id: string,
    status: SyncStatus,
    options?: { updatedAt?: string; isDeleted?: boolean }
): Promise<void> {
    const record = await getElementRecordById(id);
    if (!record) return;

    const updatedAtClause = options?.updatedAt ? `, updated_at='${esc(options.updatedAt)}'` : '';
    const parsed = options?.updatedAt ? Date.parse(options.updatedAt) : undefined;
    const lastModifiedClause = parsed && !Number.isNaN(parsed) ? `, last_modified=${parsed}` : '';
    const isDeletedClause = options?.isDeleted !== undefined ? `, is_deleted=${options.isDeleted ? 1 : 0}` : '';

    await run(
        `UPDATE element SET sync_status='${status}'${updatedAtClause}${lastModifiedClause}${isDeletedClause} WHERE id='${esc(id)}'`
    );

    if (status === 'synced' && ((options?.isDeleted && options.isDeleted) || record.is_deleted === 1)) {
        await run(`DELETE FROM element WHERE id='${esc(id)}'`);
    }
}

export async function markElementCategorySyncStatus(
    id: string,
    status: SyncStatus,
    options?: { updatedAt?: string; isDeleted?: boolean }
): Promise<void> {
    const record = await getCategoryRecordById(id);
    if (!record) return;

    const parsed = options?.updatedAt ? Date.parse(options.updatedAt) : undefined;
    const lastModifiedClause = parsed && !Number.isNaN(parsed) ? `, last_modified=${parsed}` : '';
    const isDeletedClause = options?.isDeleted !== undefined ? `, is_deleted=${options.isDeleted ? 1 : 0}` : '';

    await run(
        `UPDATE element_category SET sync_status='${status}'${lastModifiedClause}${isDeletedClause} WHERE id='${esc(id)}'`
    );

    if (status === 'synced' && ((options?.isDeleted && options.isDeleted) || record.is_deleted === 1)) {
        await run(`DELETE FROM element_category WHERE id='${esc(id)}'`);
    }
}

export async function cleanupSyncedDeletedElements(): Promise<void> {
    await run(`DELETE FROM element WHERE is_deleted = 1 AND sync_status = 'synced'`);
}

export async function cleanupSyncedDeletedCategories(): Promise<void> {
    await run(`DELETE FROM element_category WHERE is_deleted = 1 AND sync_status = 'synced'`);
}

export async function applyRemoteElement(element: RemoteElementPayload): Promise<'inserted' | 'updated' | 'skipped' | 'conflict'> {
    const remoteUpdatedAt = Date.parse(element.updatedAt);
    if (Number.isNaN(remoteUpdatedAt)) {
        return 'skipped';
    }

    const existing = await getElementRecordById(element.id);
    const metadata: Partial<SyncMetadata> = {
        syncStatus: 'synced',
        lastModified: remoteUpdatedAt,
        isDeleted: element.isDeleted ? 1 : 0,
    };

    if (element.isDeleted) {
        if (!existing) {
            return 'skipped';
        }

        if (existing.sync_status === 'pending' && (existing.last_modified ?? 0) > remoteUpdatedAt) {
            return 'conflict';
        }

        await run(
            `UPDATE element SET is_deleted = 1, sync_status = 'synced', last_modified = ${remoteUpdatedAt}, updated_at='${esc(
                element.updatedAt
            )}' WHERE id='${esc(element.id)}'`
        );
        await cleanupSyncedDeletedElements();
        return 'updated';
    }

    let categoryId = element.categoryId ?? null;
    if (!categoryId && element.categoryName) {
        categoryId = await ensureCategoryId(element.categoryName);
    }

    const record: ElementRecord = {
        id: element.id,
        project_id: element.projectId,
        category_id: categoryId ?? null,
        type: element.type ?? existing?.type ?? DEFAULT_ELEMENT_TYPE,
        name: element.name,
        content_json: element.contentJson ?? existing?.content_json ?? '{}',
        summary_json: element.summaryJson ?? existing?.summary_json ?? '{}',
        created_at: element.createdAt,
        updated_at: element.updatedAt,
    };

    if (!existing) {
        await insertElementRecord(record, metadata);
    } else {
        if (existing.sync_status === 'pending' && (existing.last_modified ?? 0) > remoteUpdatedAt) {
            return 'conflict';
        }
        await updateElementRecord(record, metadata);
    }

    if (element.tags) {
        await replaceTags(element.id, element.tags);
    }

    return existing ? 'updated' : 'inserted';
}

export async function applyRemoteElementCategory(
    category: RemoteElementCategoryPayload
): Promise<'inserted' | 'updated' | 'skipped' | 'conflict'> {
    const remoteUpdatedAt = Date.parse(category.updatedAt);
    if (Number.isNaN(remoteUpdatedAt)) {
        return 'skipped';
    }

    const existing = await getCategoryRecordById(category.id);
    const metadata: Partial<SyncMetadata> = {
        syncStatus: 'synced',
        lastModified: remoteUpdatedAt,
        isDeleted: category.isDeleted ? 1 : 0,
    };

    if (category.isDeleted) {
        if (!existing) {
            return 'skipped';
        }

        if (existing.sync_status === 'pending' && (existing.last_modified ?? 0) > remoteUpdatedAt) {
            return 'conflict';
        }

        await run(
            `UPDATE element_category SET is_deleted = 1, sync_status = 'synced', last_modified = ${remoteUpdatedAt} WHERE id='${esc(
                category.id
            )}'`
        );
        await cleanupSyncedDeletedCategories();
        return 'updated';
    }

    const record: ElementCategoryRecord = {
        id: category.id,
        name: category.name,
        description_json: category.descriptionJson ?? '{}',
        color: category.color ?? null,
    };

    if (!existing) {
        await insertCategoryRecord(record, metadata);
        return 'inserted';
    }

    if (existing.sync_status === 'pending' && (existing.last_modified ?? 0) > remoteUpdatedAt) {
        return 'conflict';
    }

    await updateCategoryRecord(record, metadata);
    return 'updated';
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
        async update(name: string, updates: { color?: string; description_json?: string }): Promise<BookElementCategory | null> {
            const normalized = normalizeCategoryName(name);
            const setParts: string[] = [];
            
            if (updates.color !== undefined) {
                setParts.push(`color='${esc(updates.color)}'`);
            }
            if (updates.description_json !== undefined) {
                setParts.push(`description_json='${esc(updates.description_json)}'`);
            }
            
            if (setParts.length === 0) {
                return findByNameInternal(normalized);
            }
            
            await run(`UPDATE element_category SET ${setParts.join(', ')} WHERE name='${esc(normalized)}'`);
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
