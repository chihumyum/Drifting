import { extractTextFromCommentBody } from '../../domain/comment';
import type { LibraryItem } from '../../domain/library-item';

/**
 * Search matches what the author can read on a material: its title, the plain
 * text of a note body or description (never the raw TipTap JSON, whose node
 * names like "paragraph" would match every note). A retired url material is a
 * note whose body holds the link, so its URL still matches as body text.
 */
export function libraryItemMatchesQuery(item: LibraryItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const fields = [
    item.title,
    item.kind === 'text' ? extractTextFromCommentBody(item.bodyJson) : null,
    extractTextFromCommentBody(item.notesJson),
  ];
  return fields.some((field) => (field ?? '').toLowerCase().includes(q));
}
