import type { LibraryItem } from '../domain/library-item';
import { indexById } from '../lib/immutable-id-index';
import type { LibraryItemRepository } from '../sqlite-repo/library-item-repo';

/** Use only inside the capture transaction with journal coverage of this base. */
export async function readWorkspaceLibrary(
  repo: LibraryItemRepository,
  previous: LibraryItem[] | undefined,
  changedIds: readonly string[] | null | undefined,
) {
  if (previous && changedIds) {
    const selected = await repo.findAll(changedIds);
    const before = indexById(previous);
    if (selected.length === changedIds.length && selected.every(({ id }) => before.has(id))) {
      // Both author ordering and updatedAt can move a row. SQLite supplies the
      // complete skinny order, with the same tie-breaker as the full read.
      const ids = await repo.findOrderedIds();
      if (ids.length === previous.length && ids.every(id => before.has(id))) {
        const replacements = indexById(selected);
        return { libraryItems: ids.map(id => replacements.get(id) ?? before.get(id)!), libraryRead: 'changed' as const };
      }
    }
  }
  return { libraryItems: await repo.findAll(), libraryRead: 'all' as const };
}
