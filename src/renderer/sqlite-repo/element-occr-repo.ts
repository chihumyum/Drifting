import { nanoid } from 'nanoid';
import loglevel from "loglevel";

const log = loglevel.getLogger("ElementOccurrenceRepository");
log.setLevel(loglevel.levels.ERROR);

// TODO: refactor this file to match others
/**
 * Element Occurrence 记录接口
 */
export interface ElementOccurrenceRecord {
  id: string;
  element_id: string;
  node_id: string;
  block_id: string;
  spans_json: string; // JSON 字符串，存储匹配位置信息
  created_at: string;
}

export interface ElementOccurrenceRepository {
  saveOccurrencesForNode(
    nodeId: string,
    elementMatches: Array<{
      elementId: string;
      matches: Array<{ text: string; position: number; length: number }>;
    }>
  ): Promise<void>;
  getOccurrencesByNode(nodeId: string): Promise<ElementOccurrenceRecord[]>;
  getOccurrencesByElement(elementId: string): Promise<Array<{
    id: string;
    element_id: string;
    node_id: string;
    node_title: string;
    spans_json: string;
    created_at: string;
  }>>;
  deleteOccurrencesByNode(nodeId: string): Promise<void>;
  deleteOccurrencesByElement(elementId: string): Promise<void>;
  countOccurrencesByElement(elementId: string): Promise<number>;
}

/**
 * 元素出现位置的数据库操作
 * 通过 IPC 与主进程的数据库交互
 */
export function createElementOccurrenceRepository(projectId?: string): ElementOccurrenceRepository {
  void projectId;

  /**
   * 保存或更新某个节点中的元素出现记录
   * 会先删除该节点的所有旧记录，然后插入新记录
   */
  const saveOccurrencesForNode = async (
    nodeId: string,
    elementMatches: Array<{
      elementId: string;
      matches: Array<{ text: string; position: number; length: number }>;
    }>
  ): Promise<void> => {
    try {
      // 删除旧记录
      await window.electronAPI.db.run(
        'DELETE FROM element_occurrence WHERE node_id = ?',
        [nodeId]
      );

      // 插入新记录
      const now = new Date().toISOString();
      for (const match of elementMatches) {
        if (match.matches.length > 0) {
          await window.electronAPI.db.run(
            `INSERT INTO element_occurrence (id, element_id, node_id, block_id, spans_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
              nanoid(),
              match.elementId,
              nodeId,
              '', // block_id 暂时为空，可以后续扩展
              JSON.stringify(match.matches),
              now
            ]
          );
        }
      }
    } catch (error) {
      log.error('[ElementOccurrenceRepository] Error saving occurrences:', error);
      throw error;
    }
  };

  /**
   * 获取某个节点中的所有元素出现记录
   */
  const getOccurrencesByNode = async (nodeId: string): Promise<ElementOccurrenceRecord[]> => {
    try {
      const results = await window.electronAPI.db.query(
        'SELECT * FROM element_occurrence WHERE node_id = ?',
        [nodeId]
      );
      return results as ElementOccurrenceRecord[];
    } catch (error) {
      log.error('[ElementOccurrenceRepository] Error getting occurrences by node:', error);
      return [];
    }
  };

  /**
   * 获取某个元素在哪些节点中出现过（反向链接）
   */
  const getOccurrencesByElement = async (elementId: string): Promise<Array<{
    id: string;
    element_id: string;
    node_id: string;
    node_title: string;
    spans_json: string;
    created_at: string;
  }>> => {
    try {
      const results = await window.electronAPI.db.query(
        `SELECT 
          eo.id,
          eo.element_id,
          eo.node_id,
          sn.title as node_title,
          eo.spans_json,
          eo.created_at
        FROM element_occurrence eo
        LEFT JOIN story_node sn ON eo.node_id = sn.id
        WHERE eo.element_id = ?
        ORDER BY eo.created_at DESC`,
        [elementId]
      );
      return results as Array<{
        id: string;
        element_id: string;
        node_id: string;
        node_title: string;
        spans_json: string;
        created_at: string;
      }>;
    } catch (error) {
      log.error('[ElementOccurrenceRepository] Error getting occurrences by element:', error);
      return [];
    }
  };

  /**
   * 删除某个节点的所有元素出现记录
   */
  const deleteOccurrencesByNode = async (nodeId: string): Promise<void> => {
    try {
      await window.electronAPI.db.run(
        'DELETE FROM element_occurrence WHERE node_id = ?',
        [nodeId]
      );
    } catch (error) {
      log.error('[ElementOccurrenceRepository] Error deleting occurrences by node:', error);
      throw error;
    }
  };

  /**
   * 删除某个元素的所有出现记录
   */
  const deleteOccurrencesByElement = async (elementId: string): Promise<void> => {
    try {
      await window.electronAPI.db.run(
        'DELETE FROM element_occurrence WHERE element_id = ?',
        [elementId]
      );
    } catch (error) {
      log.error('[ElementOccurrenceRepository] Error deleting occurrences by element:', error);
      throw error;
    }
  };

  /**
   * 统计某个元素在多少个节点中出现
   */
  const countOccurrencesByElement = async (elementId: string): Promise<number> => {
    try {
      const result = await window.electronAPI.db.get(
        'SELECT COUNT(DISTINCT node_id) as count FROM element_occurrence WHERE element_id = ?',
        [elementId]
      );
      return (result as { count: number })?.count ?? 0;
    } catch (error) {
      log.error('[ElementOccurrenceRepository] Error counting occurrences:', error);
      return 0;
    }
  };

  return {
    saveOccurrencesForNode,
    getOccurrencesByNode,
    getOccurrencesByElement,
    deleteOccurrencesByNode,
    deleteOccurrencesByElement,
    countOccurrencesByElement,
  };
}
