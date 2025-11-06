import { query, run } from '../lib/db';
import type { StoryThreadRepository } from './story_thread';
import type { StoryThread, CreateStoryThreadInput, UpdateStoryThreadInput } from '../domain/story_thread';
import type { StoryThreadRecord } from '../schema/story_thread';
import { TABLES } from '../schema/table';

const esc = (v: string) => v.replaceAll("'", "''");

function recordToDomain(record: StoryThreadRecord): StoryThread {
  let pmJson: object | undefined;
  if (record.pm_json) {
    try {
      pmJson = JSON.parse(record.pm_json);
    } catch {
      pmJson = undefined;
    }
  }
  
  return {
    id: record.id,
    projectId: record.project_id,
    name: record.name,
    color: record.color,
    summary: record.summary || undefined,
    pmJson,
    createdAt: new Date(record.created_at),
    updatedAt: new Date(record.updated_at),
  };
}

export class StoryThreadSQLiteRepository implements StoryThreadRepository {
  async createThread(input: CreateStoryThreadInput): Promise<StoryThread> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    
    const record: StoryThreadRecord = {
      id,
      project_id: input.projectId,
      name: input.name,
      color: input.color,
      summary: input.summary || null,
      pm_json: input.pmJson ? JSON.stringify(input.pmJson) : null,
      created_at: now,
      updated_at: now,
    };

    await run(
      `INSERT INTO ${TABLES.storyThread} 
       (id, project_id, name, color, summary, pm_json, created_at, updated_at) 
       VALUES (
         '${esc(record.id)}',
         '${esc(record.project_id)}',
         '${esc(record.name)}',
         '${esc(record.color)}',
         ${record.summary ? `'${esc(record.summary)}'` : 'NULL'},
         ${record.pm_json ? `'${esc(record.pm_json)}'` : 'NULL'},
         '${esc(record.created_at)}',
         '${esc(record.updated_at)}'
       )`
    );

    return recordToDomain(record);
  }

  async getThreadById(id: string): Promise<StoryThread | null> {
    const records = await query<StoryThreadRecord>(
      `SELECT * FROM ${TABLES.storyThread} WHERE id = '${esc(id)}'`
    );
    return records.length > 0 ? recordToDomain(records[0]) : null;
  }

  async getThreadsByProject(projectId: string): Promise<StoryThread[]> {
    const records = await query<StoryThreadRecord>(
      `SELECT * FROM ${TABLES.storyThread} WHERE project_id = '${esc(projectId)}' ORDER BY name ASC`
    );
    return records.map((r) => recordToDomain(r));
  }

  async updateThread(input: UpdateStoryThreadInput): Promise<StoryThread> {
    const existing = await this.getThreadById(input.id);
    if (!existing) {
      throw new Error(`Thread ${input.id} not found`);
    }

    const now = new Date().toISOString();
    const updates: string[] = [];

    if (input.name !== undefined) {
      updates.push(`name = '${esc(input.name)}'`);
    }
    if (input.color !== undefined) {
      updates.push(`color = '${esc(input.color)}'`);
    }
    if (input.summary !== undefined) {
      updates.push(`summary = ${input.summary ? `'${esc(input.summary)}'` : 'NULL'}`);
    }
    if (input.pmJson !== undefined) {
      updates.push(`pm_json = ${input.pmJson ? `'${esc(JSON.stringify(input.pmJson))}'` : 'NULL'}`);
    }

    updates.push(`updated_at = '${esc(now)}'`);

    await run(
      `UPDATE ${TABLES.storyThread} SET ${updates.join(', ')} WHERE id = '${esc(input.id)}'`
    );

    const updated = await this.getThreadById(input.id);
    if (!updated) {
      throw new Error(`Failed to retrieve updated thread ${input.id}`);
    }
    return updated;
  }

  async deleteThread(id: string): Promise<void> {
    await run(`DELETE FROM ${TABLES.storyThread} WHERE id = '${esc(id)}'`);
  }

  async addNodeToThread(nodeId: string, threadId: string): Promise<void> {
    // Get the current max order for this node
    const maxOrderResult = await query<{ max_order: number | null }>(
      `SELECT MAX(thread_order) as max_order FROM ${TABLES.nodeThread} WHERE node_id = '${esc(nodeId)}'`
    );
    const nextOrder = (maxOrderResult[0]?.max_order ?? -1) + 1;
    
    await run(
      `INSERT OR IGNORE INTO ${TABLES.nodeThread} (node_id, thread_id, thread_order) 
       VALUES ('${esc(nodeId)}', '${esc(threadId)}', ${nextOrder})`
    );
  }

  async removeNodeFromThread(nodeId: string, threadId: string): Promise<void> {
    await run(
      `DELETE FROM ${TABLES.nodeThread} WHERE node_id = '${esc(nodeId)}' AND thread_id = '${esc(threadId)}'`
    );
  }

  async getThreadsByNode(nodeId: string): Promise<StoryThread[]> {
    const records = await query<StoryThreadRecord>(
      `SELECT st.* FROM ${TABLES.storyThread} st
       INNER JOIN ${TABLES.nodeThread} nt ON nt.thread_id = st.id
       WHERE nt.node_id = '${esc(nodeId)}'
       ORDER BY nt.thread_order ASC`
    );
    return records.map((r) => recordToDomain(r));
  }

  async getNodeIdsByThread(threadId: string): Promise<string[]> {
    const records = await query<{ node_id: string }>(
      `SELECT node_id FROM ${TABLES.nodeThread} WHERE thread_id = '${esc(threadId)}'`
    );
    return records.map((r) => r.node_id);
  }

  async setNodeThreads(nodeId: string, threadIds: string[]): Promise<void> {
    // Remove all existing threads for this node
    await run(`DELETE FROM ${TABLES.nodeThread} WHERE node_id = '${esc(nodeId)}'`);
    
    // Add new threads with explicit order
    for (let i = 0; i < threadIds.length; i++) {
      await run(
        `INSERT INTO ${TABLES.nodeThread} (node_id, thread_id, thread_order) 
         VALUES ('${esc(nodeId)}', '${esc(threadIds[i])}', ${i})`
      );
    }
  }
}

