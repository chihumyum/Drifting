import type { Comment } from '../../domain/comment';
import { isCommentTargetKind } from '../../domain/entity-kinds';
import { addCommentToStickyNoteRail } from '../../hooks/useEntityStickyNoteRail';
import { useDataStore } from '../../store/data-store';
import { isShareLinkComment } from './share-comment';

/**
 * Readers' comments go on their entity's sticky-note rail by default, so the
 * author sees them beside the text at once: every open one the project holds
 * when it opens, and every one that arrives while it is open (imported here or
 * synced from another device). Each is pinned once per session; one the author
 * takes off the rail stays off until the project opens again.
 */
export function installReaderCommentRail(projectId: string): () => void {
  const pinned = new Set<string>();
  const pin = (comments: readonly Comment[]) => {
    const fresh = comments
      .filter(comment => comment.projectId === projectId && comment.status === 'open' && !pinned.has(comment.id)
        && comment.targetId && isCommentTargetKind(comment.targetKind) && isShareLinkComment(comment))
      // The rail puts the latest pin on top: pin oldest first.
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const comment of fresh) {
      pinned.add(comment.id);
      addCommentToStickyNoteRail(comment.targetKind!, comment.targetId!, comment.id);
    }
  };
  pin(useDataStore.getState().comments);
  return useDataStore.subscribe((state, previous) => {
    if (state.comments !== previous.comments) pin(state.comments);
  });
}
