import type { JSONContent } from '@tiptap/core';
import type { OutlineItem } from '../schema/book_content';
import { uuidv7 } from 'uuidv7';
import loglevel from "loglevel";

const log = loglevel.getLogger("OutlineLib");
log.setLevel(loglevel.levels.ERROR);

/**
 * Extract outline structure from TipTap JSON content
 * @param pmJson - TipTap/ProseMirror JSON string
 * @returns Array of outline items with heading hierarchy
 */
export function extractOutline(pmJson: string): OutlineItem[] {
  try {
    const doc = JSON.parse(pmJson) as JSONContent;
    const outline: OutlineItem[] = [];
    let position = 0;
    let currentHeadingIndex = -1;

    const traverse = (node: JSONContent) => {
      if (node.type === 'heading' && node.attrs?.level && (node.attrs.level === 1 || node.attrs.level === 2 || node.attrs.level === 3)) {
        const text = extractTextFromNode(node);
        if (text.trim()) {
          outline.push({
            id: `outline_${uuidv7()}_${position}`,
            level: node.attrs.level as 1 | 2 | 3,
            text: text.trim(),
            position: position++,
            paragraphsAfter: 0,
          });
          currentHeadingIndex = outline.length - 1;
        }
      } else if (node.type === 'paragraph' && currentHeadingIndex >= 0) {
        // Count paragraphs after the current heading
        outline[currentHeadingIndex].paragraphsAfter = (outline[currentHeadingIndex].paragraphsAfter || 0) + 1;
      }

      // Traverse child nodes
      if (node.content && Array.isArray(node.content)) {
        node.content.forEach(child => traverse(child));
      }
    };

    traverse(doc);
    return outline;
  } catch (error) {
    log.error('Failed to extract outline:', error);
    return [];
  }
}

/**
 * Extract plain text from a TipTap node
 */
function extractTextFromNode(node: JSONContent): string {
  if (node.type === 'text') {
    return node.text || '';
  }

  if (node.content && Array.isArray(node.content)) {
    return node.content.map(child => extractTextFromNode(child)).join('');
  }

  return '';
}

/**
 * Serialize outline to JSON string
 */
export function serializeOutline(outline: OutlineItem[]): string {
  return JSON.stringify(outline);
}

/**
 * Parse outline from JSON string
 */
export function parseOutline(outlineJson: string): OutlineItem[] {
  try {
    return JSON.parse(outlineJson) as OutlineItem[];
  } catch (error) {
    log.error('Failed to parse outline:', error);
    return [];
  }
}
