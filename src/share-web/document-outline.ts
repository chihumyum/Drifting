import { nestHeadings } from '../renderer/components/editor/outline-rail-model';
import { shareBlockText, type ShareBlock } from '../shared/share-document';

/** The headings of the copy, nested the way the editor's outline nests them. */
export function outlineOf(blocks: readonly ShareBlock[]) {
  return nestHeadings(blocks.flatMap(block => {
    const text = shareBlockText(block).trim();
    return block.type === 'heading' && block.id && text ? [{ id: block.id, level: block.level ?? 3, text }] : [];
  }));
}
