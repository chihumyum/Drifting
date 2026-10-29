// Review panel grouping: comments and TODOs gathered under the entity they
// are attached to (a chapter, element, storyline, category, note, image or
// PDF), with floating items last. Grouping is presentation only; it never
// changes what a comment targets.

import type { Comment, CommentTargetKind } from '../../domain/comment';
import { isDrift } from '../../domain/book-node';
import type { useDataStore } from '../../store/data-store';

export type ReviewGroupData = Pick<
  ReturnType<typeof useDataStore.getState>,
  'bookNodes' | 'bookElements' | 'storylines' | 'bookElementCategories' | 'libraryItems'
>;

export interface ReviewGroup {
  /** `kind:id`, or `floating` for items attached to nothing. */
  key: string;
  targetKind: CommentTargetKind | null;
  targetId: string | null;
  items: Comment[];
}

export const FLOATING_REVIEW_GROUP = 'floating';

/** Every block id in a ProseMirror JSON body, in document order. */
export function blockOrder(json: string | null | undefined): Map<string, number> {
  const order = new Map<string, number>();
  if (!json) return order;
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch {
    return order;
  }
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const record = node as { attrs?: { id?: unknown }; content?: unknown };
    const id = record.attrs?.id;
    if (typeof id === 'string' && !order.has(id)) order.set(id, order.size);
    if (Array.isArray(record.content)) record.content.forEach(walk);
  };
  walk(root);
  return order;
}

/** The body whose block order ranks a group's items, when it is in memory.
 *  Chapter bodies live outside the data store, so chapters keep time order. */
function groupBody(data: ReviewGroupData, kind: CommentTargetKind, id: string): string | null {
  switch (kind) {
    case 'library_item': {
      const item = data.libraryItems.find((candidate) => candidate.id === id);
      return item?.kind === 'text' ? item.bodyJson : null;
    }
    case 'element':
      return data.bookElements.find((element) => element.id === id)?.contentJson ?? null;
    case 'storyline':
      return data.storylines.find((storyline) => storyline.id === id)?.contentJson ?? null;
    case 'category':
      return data.bookElementCategories.find((category) => category.id === id)?.contentJson ?? null;
    default:
      return null;
  }
}

/**
 * Groups already-sorted items (newest first) by target. Groups follow their
 * newest item; floating items come last. Inside a group, block-anchored items
 * follow the document when its body is available, then the rest keep the
 * incoming order.
 */
export function groupReviewItems(items: readonly Comment[], data: ReviewGroupData): ReviewGroup[] {
  const groups = new Map<string, ReviewGroup>();
  for (const comment of items) {
    const attached = comment.targetKind !== null && comment.targetId !== null;
    const key = attached ? `${comment.targetKind}:${comment.targetId}` : FLOATING_REVIEW_GROUP;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        targetKind: attached ? comment.targetKind : null,
        targetId: attached ? comment.targetId : null,
        items: [],
      };
      groups.set(key, group);
    }
    group.items.push(comment);
  }
  const result: ReviewGroup[] = [];
  let floating: ReviewGroup | null = null;
  for (const group of groups.values()) {
    if (group.key === FLOATING_REVIEW_GROUP) {
      floating = group;
      continue;
    }
    const order = group.targetKind && group.targetId ? blockOrder(groupBody(data, group.targetKind, group.targetId)) : null;
    if (order && order.size > 0) {
      const incoming = new Map(group.items.map((comment, index) => [comment.id, index]));
      const rank = (comment: Comment) =>
        comment.targetBlockId !== null && order.has(comment.targetBlockId) ? order.get(comment.targetBlockId)! : Infinity;
      group.items.sort((a, b) => rank(a) - rank(b) || incoming.get(a.id)! - incoming.get(b.id)!);
    }
    result.push(group);
  }
  if (floating) result.push(floating);
  return result;
}

/** Muted ink for a mark whose thing has no colour of its own. */
export const UNCOLOURED_MARK = 'hsl(var(--ink-4))';

/**
 * The pigment of a target's sand mark, as the left sidebar paints it: a
 * chapter or drift takes its primary storyline's colour, an element its
 * category's, a storyline or category its own; anything else muted ink.
 */
export function reviewTargetColor(
  data: Pick<ReviewGroupData, 'bookElements' | 'storylines' | 'bookElementCategories'>,
  primaryStorylineByNode: Readonly<Record<string, string | null>>,
  kind: CommentTargetKind,
  id: string,
): string {
  const storylineColor = (storylineId: string | null | undefined) =>
    data.storylines.find((storyline) => storyline.id === storylineId)?.color;
  const categoryColor = (categoryId: string | null | undefined) =>
    data.bookElementCategories.find((category) => category.id === categoryId)?.color;
  switch (kind) {
    case 'node': return storylineColor(primaryStorylineByNode[id]) ?? UNCOLOURED_MARK;
    case 'element': return categoryColor(data.bookElements.find((element) => element.id === id)?.categoryId) ?? UNCOLOURED_MARK;
    case 'storyline': return storylineColor(id) ?? UNCOLOURED_MARK;
    case 'category': return categoryColor(id) ?? UNCOLOURED_MARK;
    default: return UNCOLOURED_MARK;
  }
}

/** The current name of a group's target; null when it no longer exists. */
export function reviewGroupTitle(
  data: ReviewGroupData,
  kind: CommentTargetKind,
  id: string,
): { title: string; isDrift: boolean } | null {
  switch (kind) {
    case 'node': {
      const node = data.bookNodes.find((candidate) => candidate.id === id);
      return node ? { title: node.title, isDrift: isDrift(node) } : null;
    }
    case 'element': {
      const element = data.bookElements.find((candidate) => candidate.id === id);
      return element ? { title: element.name, isDrift: false } : null;
    }
    case 'storyline': {
      const storyline = data.storylines.find((candidate) => candidate.id === id);
      return storyline ? { title: storyline.name, isDrift: false } : null;
    }
    case 'category': {
      const category = data.bookElementCategories.find((candidate) => candidate.id === id);
      return category ? { title: category.name, isDrift: false } : null;
    }
    case 'library_item': {
      const item = data.libraryItems.find((candidate) => candidate.id === id);
      return item ? { title: item.title, isDrift: false } : null;
    }
    default:
      return null;
  }
}
