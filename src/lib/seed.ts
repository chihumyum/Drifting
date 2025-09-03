import { query, run } from './db'

export async function seedIfEmpty() {
  const rows = await query<{ count: number }>('SELECT COUNT(*) as count FROM story_node')
  if ((rows?.[0]?.count ?? 0) > 0) return
  const id = crypto.randomUUID()
  const node1 = crypto.randomUUID()
  const node2 = crypto.randomUUID()
  await run(`INSERT INTO project (id, name, created_at) VALUES ('${id}', 'Sample Project', '${new Date().toISOString()}');`)
  await run(`INSERT INTO story_node (id, project_id, type, title, order_key) VALUES ('${node1}', '${id}', 'chapter', 'Chapter 1', 1.0);`)
  await run(`INSERT INTO story_node (id, project_id, type, title, order_key) VALUES ('${node2}', '${id}', 'scene', 'Scene 1.1', 1.1);`)
  await run(`INSERT INTO node_edge (id, project_id, src_node_id, dst_node_id, kind, label, weight) VALUES ('${crypto.randomUUID()}', '${id}', '${node1}', '${node2}', 'chronology', 'then', 1.0);`)
}



