import { extractTextFromCommentBody } from '../../domain/comment';
import type { LibraryItem } from '../../domain/library-item';

/**
 * Search matches what the author can read on a material: its title, the plain
 * text of a text body or notes (never the raw TipTap JSON, whose node names
 * like "paragraph" would match every text material), and a link's URL.
 */
export function libraryItemMatchesQuery(item: LibraryItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const fields = [
    item.title,
    item.kind === 'url' ? item.externalUrl : null,
    item.kind === 'text' ? extractTextFromCommentBody(item.bodyJson) : null,
    extractTextFromCommentBody(item.notesJson),
  ];
  return fields.some((field) => (field ?? '').toLowerCase().includes(q));
}
