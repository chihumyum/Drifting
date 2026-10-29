import { extractTextFromCommentBody } from '../../domain/comment';
import type { LibraryItem } from '../../domain/library-item';

// Rows are immutable workspace projections. Weak ownership releases removed
// rows and old workspaces instead of growing with every visited project.
const searchText = new WeakMap<LibraryItem, { kind: LibraryItem['kind']; title: string; body: string | null; notes: string | null; text: string }>();

/**
 * Search matches what the author can read on a material: its title, the plain
 * text of a note body or description (never the raw TipTap JSON, whose node
 * names like "paragraph" would match every note). A retired url material is a
 * note whose body holds the link, so its URL still matches as body text.
 */
export function libraryItemMatchesQuery(item: LibraryItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const previous = searchText.get(item);
  if (previous && previous.kind === item.kind && previous.title === item.title && previous.body === item.bodyJson && previous.notes === item.notesJson) {
    return previous.text.includes(q);
  }
  const text = [
    item.title,
    item.kind === 'text' ? extractTextFromCommentBody(item.bodyJson) : null,
    extractTextFromCommentBody(item.notesJson),
  ].map(field => (field ?? '').toLowerCase()).join('\n');
  searchText.set(item, { kind: item.kind, title: item.title, body: item.bodyJson, notes: item.notesJson, text });
  return text.includes(q);
}
