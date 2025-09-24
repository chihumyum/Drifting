import { query, run } from './db'
import type { EntityCategory } from '../model/schema'
import { DEFAULT_entity_CATEGORIES } from '../model/schema'

export type CodexEntry = { id: string; project_id: string; type: string; name: string }

export async function listEntries(limit = 100): Promise<CodexEntry[]> {
  return query<CodexEntry>(`SELECT id, project_id, type, name FROM entity ORDER BY name LIMIT ${limit}`)
}

export async function createEntity(projectId: string, type: string, name: string) {
  await ensureEntityCategory(type)
  const id = crypto.randomUUID()
  await run(`INSERT INTO entity (id, project_id, type, name) VALUES ('${id}', '${projectId}', '${escapeSql(type)}', '${escapeSql(name)}')`)
  return id
}

export async function listEntityCategories(): Promise<EntityCategory[]> {
  const rows = await query<EntityCategory>('SELECT name, color, created_at FROM entity_category ORDER BY name ASC')
  if (!rows.length) {
    await seedDefaultCategories()
    return query<EntityCategory>('SELECT name, color, created_at FROM entity_category ORDER BY name ASC')
  }
  return rows
}

export async function ensureEntityCategory(name: string) {
  const trimmed = name.trim()
  if (!trimmed) return
  const safeName = escapeSql(trimmed)
  await run(`INSERT INTO entity_category (name, color) VALUES ('${safeName}', NULL) ON CONFLICT(name) DO NOTHING`)
}

async function seedDefaultCategories() {
  for (const cat of DEFAULT_entity_CATEGORIES) {
    await ensureEntityCategory(cat)
  }
}

export async function ensureProjectId(): Promise<string> {
  const row = (await query<{ id: string }>('SELECT id FROM project LIMIT 1'))[0]
  if (row?.id) return row.id
  const id = crypto.randomUUID()
  await run(`INSERT INTO project (id, name, created_at) VALUES ('${id}', 'Untitled', '${new Date().toISOString()}')`)
  return id
}

export async function linkNodeToEntry(nodeId: string, entryId: string, role: string = 'mention') {
  const id = crypto.randomUUID()
  await run(`INSERT INTO node_entity_link (id, node_id, entity_id, role, weight) VALUES ('${id}', '${nodeId}', '${entryId}', '${escapeSql(role)}', 1.0)`)
}

export async function listNodeLinkedEntries(nodeId: string) {
  return query<{ id: string; name: string; type: string; role: string }>(
    `SELECT e.id, e.name, e.type, l.role FROM node_entity_link l JOIN entity e ON e.id = l.entity_id WHERE l.node_id='${nodeId}' ORDER BY e.name`
  )
}

function escapeSql(s: string) {
  return s.replaceAll("'", "''")
}


