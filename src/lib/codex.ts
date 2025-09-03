import { query, run } from './db'

export type CodexEntry = { id: string; project_id: string; type: string; name: string }

export async function listEntries(limit = 100): Promise<CodexEntry[]> {
  return query<CodexEntry>(`SELECT id, project_id, type, name FROM entry ORDER BY name LIMIT ${limit}`)
}

export async function createEntry(projectId: string, type: string, name: string) {
  const id = crypto.randomUUID()
  await run(`INSERT INTO entry (id, project_id, type, name) VALUES ('${id}', '${projectId}', '${escapeSql(type)}', '${escapeSql(name)}')`)
  return id
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
  await run(`INSERT INTO node_entry_link (id, node_id, entry_id, role, weight) VALUES ('${id}', '${nodeId}', '${entryId}', '${escapeSql(role)}', 1.0)`)
}

export async function listNodeLinkedEntries(nodeId: string) {
  return query<{ id: string; name: string; type: string; role: string }>(
    `SELECT e.id, e.name, e.type, l.role FROM node_entry_link l JOIN entry e ON e.id = l.entry_id WHERE l.node_id='${nodeId}' ORDER BY e.name`
  )
}

function escapeSql(s: string) {
  return s.replaceAll("'", "''")
}



