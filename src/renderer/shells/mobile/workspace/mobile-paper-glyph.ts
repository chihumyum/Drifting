import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';
import { useDataStore } from '../../../store/data-store';
import { isDrift } from '../../../domain/book-node';

/** The workspace tab character for a paper's entity type — the same glyph
 * vocabulary as the desktop tabs (§ ❦ ¶ ◆ ⌘ ☰). */
export function usePaperGlyph(target: WorkspaceTarget): string {
  const bookNodes = useDataStore((s) => s.bookNodes);
  switch (target.entityType) {
    case 'node': {
      const node = bookNodes.find((item) => item.id === target.id);
      return node && isDrift(node) ? '❦' : '§';
    }
    case 'storyline':
      return '¶';
    case 'element':
      return '◆';
    case 'category':
      return '⌘';
    case 'all-chapters':
      return '☰';
  }
}
