import { events } from './events';

async function run(sql: string, params: unknown[] = []) {
  await window.electronAPI.db.run(sql, params);
}

async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return window.electronAPI.db.query(sql, params) as Promise<T[]>;
}

export async function createChapter(title: string) {
  const project = (await query<{ id: string }>('SELECT id FROM project LIMIT 1'))[0];
  const projectId = project?.id || 'default-project';

  if (!project) {
    // Create default project if it doesn't exist
    const now = new Date().toISOString();
    await run(
      `INSERT INTO project (id, project_name, author, description, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [projectId, 'Default Project', 'Author', 'Your default project', now, now],
    );
  }

  const last = (
    await query<{ start: number }>('SELECT start FROM story_node ORDER BY start DESC LIMIT 1')
  )[0];
  const start = (last?.start ?? 0) + 1;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await run(
    `INSERT INTO story_node (
      id, project_id, title, start, created_at, updated_at, sync_status, is_deleted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, projectId, title, start, now, now, 'synced', 0],
  );

  events.emit('nodes:changed');
  return id;
}

export async function createScene() {
  // placeholder
}

export async function createBeat() {
  // placeholder
}
