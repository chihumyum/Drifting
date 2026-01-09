import { query, run } from '../lib/db';
import type { Project } from '../domain/project';
import type { Project as ProjectRecord } from '../schema/book_general';
import type {
  ProjectRepository,
  ProjectCreateData,
  ProjectUpdateData,
} from './project';
import { v7 as uuidv7 } from 'uuid';

const esc = (v: string) => v.replaceAll("'", "''");

function recordToDomain(record: ProjectRecord): Project {
  return {
    id: record.id,
    projectName: record.project_name ?? null,
    author: record.author ?? null,
    description: record.description ?? null,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function domainToRecord(project: Project): ProjectRecord {
  return {
    id: project.id,
    project_name: project.projectName ?? '',
    author: project.author ?? '',
    description: project.description ?? '',
    created_at: project.createdAt,
    updated_at: project.updatedAt,
  };
}

export class ProjectRepositorySQLite implements ProjectRepository {
  async findById(id: string): Promise<Project | null> {
    const rows = await query<ProjectRecord>(
      `SELECT * FROM project WHERE id='${esc(id)}' LIMIT 1`
    );
    return rows[0] ? recordToDomain(rows[0]) : null;
  }

  async findAll(): Promise<Project[]> {
    const rows = await query<ProjectRecord>(
      `SELECT * FROM project ORDER BY created_at DESC`
    );
    return rows.map(recordToDomain);
  }

  async create(data: ProjectCreateData): Promise<Project> {
    const now = new Date().toISOString();
    const id = data.id ?? uuidv7();
    
    const record: ProjectRecord = {
      id,
      project_name: data.projectName ?? '',
      author: data.author ?? '',
      description: data.description ?? '',
      created_at: data.createdAt ?? now,
      updated_at: data.updatedAt ?? now,
    };

    await run(
      `INSERT INTO project (id, project_name, author, description, created_at, updated_at)
       VALUES (
         '${esc(record.id)}',
         ${record.project_name ? `'${esc(record.project_name)}'` : 'NULL'},
         ${record.author ? `'${esc(record.author)}'` : 'NULL'},
         ${record.description ? `'${esc(record.description)}'` : 'NULL'},
         '${esc(record.created_at)}',
         '${esc(record.updated_at)}'
       )`
    );

    return recordToDomain(record);
  }

  async update(id: string, data: ProjectUpdateData): Promise<Project | null> {
    const existing = await this.findById(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const updated: Project = {
      ...existing,
      projectName: data.projectName !== undefined ? data.projectName : existing.projectName,
      author: data.author !== undefined ? data.author : existing.author,
      description: data.description !== undefined ? data.description : existing.description,
      updatedAt: data.updatedAt ?? now,
    };

    const record = domainToRecord(updated);
    await run(
      `UPDATE project SET
         project_name=${record.project_name ? `'${esc(record.project_name)}'` : 'NULL'},
         author=${record.author ? `'${esc(record.author)}'` : 'NULL'},
         description=${record.description ? `'${esc(record.description)}'` : 'NULL'},
         updated_at='${esc(record.updated_at)}'
       WHERE id='${esc(id)}'`
    );

    return updated;
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.findById(id);
    if (!existing) return false;

    await run(`DELETE FROM project WHERE id='${esc(id)}'`);
    return true;
  }

  async addElementCategory(projectId: string, categoryId: string): Promise<void> {
    const now = new Date().toISOString();
    await run(
      `INSERT OR IGNORE INTO project_element_category (project_id, category_id, created_at)
       VALUES ('${esc(projectId)}', '${esc(categoryId)}', '${esc(now)}')`
    );
  }

  async removeElementCategory(projectId: string, categoryId: string): Promise<void> {
    await run(
      `DELETE FROM project_element_category 
       WHERE project_id='${esc(projectId)}' AND category_id='${esc(categoryId)}'`
    );
  }

  async getElementCategories(projectId: string): Promise<string[]> {
    const rows = await query<{ category_id: string }>(
      `SELECT category_id FROM project_element_category 
       WHERE project_id='${esc(projectId)}'`
    );
    return rows.map(r => r.category_id);
  }
}
