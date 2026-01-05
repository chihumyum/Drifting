import type { JSONContent } from '@tiptap/core';
import type { BookElement } from '../domain/book_element';

/**
 * 元素匹配结果
 */
export interface ElementMatch {
  elementId: string;
  elementName: string;
  category: string;
  // 在文本中的位置信息
  matches: Array<{
    text: string;
    position: number;
    length: number;
  }>;
}

/**
 * 元素解析服务
 * 负责从文本内容中识别和提取元素引用
 */
export class ElementParserService {
  /**
   * 从 Tiptap JSON 内容中解析出所有匹配的元素
   */
  static parseElementsFromContent(
    content: JSONContent,
    availableElements: BookElement[]
  ): ElementMatch[] {
    const matches = new Map<string, ElementMatch>();

    // 提取所有文本内容
    const textContent = this.extractTextFromJSON(content);

    // 对每个元素名称进行匹配
    availableElements.forEach((element) => {
      const elementMatches = this.findMatches(textContent, element.name);

      if (elementMatches.length > 0) {
        matches.set(element.id, {
          elementId: element.id,
          elementName: element.name,
          category: element.category,
          matches: elementMatches,
        });
      }
    });

    return Array.from(matches.values());
  }

  /**
   * 从 Tiptap JSON 中递归提取所有文本
   */
  private static extractTextFromJSON(node: JSONContent): string {
    let text = '';

    if (node.type === 'text' && node.text) {
      text += node.text;
    }

    if (node.content) {
      node.content.forEach((child) => {
        text += this.extractTextFromJSON(child);
        text += ' '; // 添加空格分隔不同节点的文本
      });
    }

    return text;
  }

  /**
   * 在文本中查找所有匹配项
   */
  private static findMatches(
    text: string,
    searchTerm: string
  ): Array<{ text: string; position: number; length: number }> {
    const matches: Array<{ text: string; position: number; length: number }> = [];
    const regex = new RegExp(this.escapeRegExp(searchTerm), 'g');

    let match;
    while ((match = regex.exec(text)) !== null) {
      matches.push({
        text: match[0],
        position: match.index,
        length: searchTerm.length,
      });
    }

    return matches;
  }

  /**
   * 转义正则表达式特殊字符
   */
  private static escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * 检查两个元素匹配结果是否有差异
   * 用于判断是否需要更新数据库
   */
  static hasChanges(
    oldMatches: ElementMatch[],
    newMatches: ElementMatch[]
  ): boolean {
    if (oldMatches.length !== newMatches.length) {
      return true;
    }

    const oldIds = new Set(oldMatches.map((m) => m.elementId));
    const newIds = new Set(newMatches.map((m) => m.elementId));

    if (oldIds.size !== newIds.size) {
      return true;
    }

    for (const id of oldIds) {
      if (!newIds.has(id)) {
        return true;
      }
    }

    return false;
  }
}
