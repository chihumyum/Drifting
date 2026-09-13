import type { Comment, CommentAction } from '../domain/comment';
import { indexById } from '../lib/immutable-id-index';

/** Only inside the capture transaction, with journal coverage of this base. */
export async function readWorkspaceComments<T extends Comment | CommentAction>(
  repo: { findAll(ids?: readonly string[]): Promise<T[]> },
  previous: T[] | undefined,
  changedIds: readonly string[] | null | undefined,
) {
  if (previous && changedIds?.length) {
    const selected = await repo.findAll(changedIds);
    const before = indexById(previous);
    // Both collections use createdAt then rowid. Covered stable identities and
    // unchanged timestamps preserve that order, including ties, without an ID scan.
    if (selected.length === changedIds.length && selected.every(row => {
      const old = before.get(row.id);
      return old && old.createdAt === row.createdAt;
    })) {
      const replacements = indexById(selected);
      return { rows: previous.map(row => replacements.get(row.id) ?? row), read: 'changed' as const };
    }
  }
  return { rows: await repo.findAll(), read: 'all' as const };
}
