import type { Database } from 'better-sqlite3';
import { createElementOccurrenceRepository, type ElementOccurrenceRepository } from '../sqlite-repo/element-occr-repo';
import type { BookElement } from '../domain/book-element';
import type { JSONContent } from '@tiptap/core';
import { ElementParserService, type ElementMatch } from './element-parser.service';

/**
 * 获取数据库实例的辅助函数
 * 这个函数需要在主进程中实现，从那里获取 better-sqlite3 的 Database 实例
 */
let dbInstance: Database | null = null;

export function setDatabaseInstance(db: Database): void {
  dbInstance = db;
}

export function getDatabaseInstance(): Database | null {
  return dbInstance;
}

/**
 * 元素自动链接管理服务
 * 提供便捷的 API 来管理元素出现记录
 */
export class ElementAutoLinkManager {
  private repo: ElementOccurrenceRepository | null = null;

  constructor() {
    this.repo = createElementOccurrenceRepository();
  }

  /**
   * 解析并保存元素出现记录
   */
  async parseAndSave(
    nodeId: string,
    content: JSONContent,
    availableElements: BookElement[]
  ): Promise<ElementMatch[]> {
    // 解析内容
    const matches = ElementParserService.parseElementsFromContent(
      content,
      availableElements
    );

    // 保存到数据库
    if (this.repo) {
      this.repo.saveOccurrencesForNode(
        nodeId,
        matches.map((m) => ({
          elementId: m.elementId,
          matches: m.matches,
        }))
      );
    }

    return matches;
  }

  /**
   * 获取某个元素的反向链接
   */
  async getBacklinks(elementId: string) {
    if (!this.repo) {
      return [];
    }
    return this.repo.getOccurrencesByElement(elementId);
  }

  /**
   * 获取某个节点中的元素出现记录
   */
  async getOccurrencesInNode(nodeId: string) {
    if (!this.repo) {
      return [];
    }
    return this.repo.getOccurrencesByNode(nodeId);
  }

  /**
   * 统计元素被引用的次数
   */
  async countReferences(elementId: string): Promise<number> {
    if (!this.repo) {
      return 0;
    }
    return this.repo.countOccurrencesByElement(elementId);
  }
}
