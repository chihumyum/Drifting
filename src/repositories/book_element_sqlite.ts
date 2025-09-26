import type { ElementRecord, ElementCategoryRecord } from '../schema/book_element';
import type { BookElementRepository, BookElementCategoryRepository } from './book_element';
import { run, query } from '../lib/db';

// NOTE: Current DB schema (DB_SCHEMA) is empty placeholder. The SQL below assumes
// tables: entity (id, project_id, category_id, type, name, content_json, summary_json, created_at, updated_at)
//         entity_category (id, name, description_json, color)
//         entity_tag (id, element_id, name, created_at)
// Adjust the column names if your actual migration differs.

const esc = (v: string) => v.replaceAll("'", "''");

export function createBookElementSqliteRepository(projectId: string): BookElementRepository {
    return {
        async findById(id: string): Promise<ElementRecord | null> {
            const rows = await query<ElementRecord>(`SELECT * FROM entity WHERE id='${esc(id)}'`);
            return rows[0] ?? null;
        },
        async findAll(): Promise<ElementRecord[]> {
            return query<ElementRecord>(`SELECT * FROM entity WHERE project_id='${esc(projectId)}'`);
        },
        async findAllByProject(pid: string): Promise<ElementRecord[]> {
            return query<ElementRecord>(`SELECT * FROM entity WHERE project_id='${esc(pid)}'`);
        },
        async findAllByCategory(pid: string, category: string): Promise<ElementRecord[]> {
            // Join category name -> category_id
            return query<ElementRecord>(
                `SELECT e.* FROM entity e JOIN entity_category c ON e.category_id = c.id
         WHERE e.project_id='${esc(pid)}' AND c.name='${esc(category)}'`
            );
        },
        async findAllByTag(pid: string, tag: string): Promise<ElementRecord[]> {
            return query<ElementRecord>(
                `SELECT e.* FROM entity e JOIN entity_tag t ON e.id = t.element_id
         WHERE e.project_id='${esc(pid)}' AND t.name='${esc(tag)}'`
            );
        },
        async create(data: Partial<ElementRecord>): Promise<ElementRecord> {
            const id = data.id ?? crypto.randomUUID();
            const catId = data.category_id ?? '';
            const now = new Date().toISOString();
            const rec: ElementRecord = {
                id,
                project_id: data.project_id ?? projectId,
                category_id: catId,
                type: data.type ?? '',
                name: data.name ?? '',
                content_json: data.content_json ?? '{}',
                summary_json: data.summary_json ?? '{}',
                created_at: data.created_at ?? now,
                updated_at: data.updated_at ?? now,
            };
            await run(`INSERT INTO entity (id, project_id, category_id, type, name, content_json, summary_json, created_at, updated_at)
        VALUES ('${esc(rec.id)}','${esc(rec.project_id)}','${esc(rec.category_id)}','${esc(rec.type)}','${esc(rec.name)}','${esc(rec.content_json)}','${esc(rec.summary_json)}','${esc(rec.created_at)}','${esc(rec.updated_at)}')`);
            return rec;
        },
        async update(id: string, data: Partial<ElementRecord>): Promise<ElementRecord | null> {
            const existing = await this.findById(id);
            if (!existing) return null;
            const updated: ElementRecord = {
                ...existing,
                ...data,
                updated_at: new Date().toISOString(),
            };
            await run(`UPDATE entity SET
        project_id='${esc(updated.project_id)}',
        category_id='${esc(updated.category_id)}',
        type='${esc(updated.type)}',
        name='${esc(updated.name)}',
        content_json='${esc(updated.content_json)}',
        summary_json='${esc(updated.summary_json)}',
        updated_at='${esc(updated.updated_at)}'
        WHERE id='${esc(id)}'`);
            return updated;
        },
        async delete(id: string): Promise<boolean> {
            await run(`DELETE FROM entity WHERE id='${esc(id)}'`);
            return true;
        },
        async ensureCategory(category: ElementCategoryRecord): Promise<void> {
            await run(`INSERT OR IGNORE INTO entity_category (id, name, description_json, color)
        VALUES ('${esc(category.id)}','${esc(category.name)}','${esc(category.description_json)}',${category.color ? `'${esc(category.color)}'` : 'NULL'})`);
        },
        async setElementCategory(entityId: string, categoryId: string): Promise<void> {
            await run(`UPDATE entity SET category_id='${esc(categoryId)}' WHERE id='${esc(entityId)}'`);
        },
        async getElementCategory(entityId: string): Promise<string | null> {
            const rows = await query<{ category_id: string }>(`SELECT category_id FROM entity WHERE id='${esc(entityId)}'`);
            return rows[0]?.category_id ?? null;
        },
        async updateElementCategory(entityId: string, categoryId: string): Promise<void> {
            await run(`UPDATE entity SET category_id='${esc(categoryId)}' WHERE id='${esc(entityId)}'`);
        },
        async getElementTags(entityId: string): Promise<string[]> {
            const rows = await query<{ name: string }>(`SELECT name FROM entity_tag WHERE element_id='${esc(entityId)}'`);
            return rows.map(r => r.name);
        },
        async addElementTag(entityId: string, tag: string): Promise<void> {
            await run(`INSERT OR IGNORE INTO entity_tag (id, element_id, name, created_at)
        VALUES ('${crypto.randomUUID()}','${esc(entityId)}','${esc(tag)}','${new Date().toISOString()}')`);
        },
        async removeElementTag(entityId: string, tag: string): Promise<void> {
            await run(`DELETE FROM entity_tag WHERE element_id='${esc(entityId)}' AND name='${esc(tag)}'`);
        },
        async setElementTags(entityId: string, tags: string[]): Promise<void> {
            await run(`DELETE FROM entity_tag WHERE element_id='${esc(entityId)}'`);
            for (const t of tags) {
                await run(`INSERT INTO entity_tag (id, element_id, name, created_at)
          VALUES ('${crypto.randomUUID()}','${esc(entityId)}','${esc(t)}','${new Date().toISOString()}')`);
            }
        },
        async getElementContent(entityId: string): Promise<string> {
            const row = await this.findById(entityId);
            return row?.content_json ?? '{}';
        },
        async setElementContent(entityId: string, content: string): Promise<void> {
            await run(`UPDATE entity SET content_json='${esc(content)}', updated_at='${esc(new Date().toISOString())}' WHERE id='${esc(entityId)}'`);
        }
    };
}

export function createCategorySqliteRepository(): BookElementCategoryRepository {
    return {
        async findAll(): Promise<string[]> {
            const rows = await query<{ name: string }>(`SELECT name FROM entity_category`);
            return rows.map(r => r.name);
        },
        async findByName(name: string): Promise<ElementCategoryRecord | null> {
            const rows = await query<ElementCategoryRecord>(`SELECT * FROM entity_category WHERE name='${esc(name)}'`);
            return rows[0] ?? null;
        },
        async create(name: string, color?: string): Promise<ElementCategoryRecord> {
            const rec: ElementCategoryRecord = {
                id: crypto.randomUUID(),
                name,
                description_json: JSON.stringify({ description: '' }),
                color,
            };
            await run(`INSERT INTO entity_category (id, name, description_json, color)
        VALUES ('${esc(rec.id)}','${esc(rec.name)}','${esc(rec.description_json)}',${color ? `'${esc(color)}'` : 'NULL'})`);
            return rec;
        },
        async update(name: string, color: string): Promise<ElementCategoryRecord | null> {
            await run(`UPDATE entity_category SET color='${esc(color)}' WHERE name='${esc(name)}'`);
            return this.findByName(name);
        },
        async delete(name: string): Promise<boolean> {
            await run(`DELETE FROM entity_category WHERE name='${esc(name)}'`);
            return true;
        },
        async ensureCategory(name: string): Promise<void> {
            await run(`INSERT OR IGNORE INTO entity_category (id, name, description_json) VALUES ('${crypto.randomUUID()}','${esc(name)}','{}')`);
        }
    };
}
