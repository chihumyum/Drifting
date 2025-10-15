import { query, run } from './db'
import { ensureElementCategory, ensureProjectId } from './book_element'
import { MOCK_ELEMENTS, MOCK_ELEMENT_CATEGORIES } from '../schema/table'

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

function escapeSql(value: string) {
  return value.replaceAll("'", "''")
}

export async function seedMockEntitiesIfEmpty() {
  const rows = await query<{ count: number }>('SELECT COUNT(*) as count FROM element')
  if ((rows?.[0]?.count ?? 0) > 0) return

  const projectId = await ensureProjectId()
  for (const category of MOCK_ELEMENT_CATEGORIES) {
    await ensureElementCategory(category.name, category.color ?? null)
    if (category.color) {
      await run(`UPDATE element_category SET color='${escapeSql(category.color)}' WHERE name='${escapeSql(category.name)}'`)
    }
  }

  for (const mock of MOCK_ELEMENTS) {
    const record = {
      ...mock,
      project_id: projectId,
    }
    await run(`
      INSERT INTO element (id, project_id, type, name, aliases_json, attributes_json, canonical_summary, created_at, updated_at)
      VALUES (
        '${escapeSql(record.id)}',
        '${escapeSql(projectId)}',
        '${escapeSql(record.type)}',
        '${escapeSql(record.name)}',
        '${escapeSql(record.aliases_json)}',
        '${escapeSql(record.attributes_json)}',
        ${record.canonical_summary ? `'${escapeSql(record.canonical_summary)}'` : 'NULL'},
        '${escapeSql(record.created_at)}',
        '${escapeSql(record.updated_at)}'
      )
    `)
  }
}

export async function seedMockData() {
  await seedIfEmpty()
  await seedMockEntitiesIfEmpty()
}
