import type { BookElement } from '../domain/book-element';
import { indexById } from '../lib/immutable-id-index';
import type { ElementRepository } from '../sqlite-repo/element-repo';

/** Called inside the projection's read transaction, with a trusted covered base. */
export async function readWorkspaceElements(
  repo: ElementRepository,
  previous: BookElement[] | undefined,
  changedIds: readonly string[] | null | undefined,
) {
  if (previous && changedIds) {
    const selected = await repo.findAll(changedIds);
    const before = indexById(previous);
    if (selected.length === changedIds.length && selected.every(({ id }) => before.has(id))) {
      // updatedAt changes on ordinary edits. Let SQLite order a skinny ID
      // projection, including ties, rather than guessing order in JavaScript.
      const ids = await repo.findLiveIds();
      const replacements = indexById(selected);
      if (ids.length === previous.length && ids.every((id) => before.has(id))) {
        return { bookElements: ids.map((id) => replacements.get(id) ?? before.get(id)!),
          trashedElements: [], elementRead: 'changed' as const };
      }
    }
  }
  // Identity replacement is rejected by coverage before entering this helper;
  // additions, removals, visibility changes and large batches read both slices.
  const [bookElements, trashedElements] = await Promise.all([repo.findAll(), repo.findTrashed()]);
  return { bookElements, trashedElements, elementRead: 'all' as const };
}
