import { run, query } from './db'
import { events } from './events'

export async function createChapter(title: string) {
  const project = (await query<{ id: string }>('SELECT id FROM project LIMIT 1'))[0]
  const projectId = project?.id || crypto.randomUUID()
  if (!project) {
    await run(`INSERT INTO project (id, name, created_at) VALUES ('${projectId}', 'Untitled', '${new Date().toISOString()}')`)
  }
  const last = (await query<{ order_key: number }>('SELECT order_key FROM story_node ORDER BY order_key DESC LIMIT 1'))[0]
  const orderKey = (last?.order_key ?? 0) + 1
  const id = crypto.randomUUID()
  await run(`INSERT INTO story_node (id, project_id, type, title, order_key) VALUES ('${id}', '${projectId}', 'chapter', '${escapeSql(title)}', ${orderKey})`)
  events.emit('nodes:changed')
  return id
}

function escapeSql(s: string) {
  return s.replaceAll("'", "''")
}



