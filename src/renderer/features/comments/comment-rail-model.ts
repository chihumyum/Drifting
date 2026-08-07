import {
  commentBlockIds,
  getBlockSnapshotsFromAnchor,
  getTextAnchorFromAnchor,
  type Comment,
} from '../../domain/comment';

export const COPILOT_ACTIVE_MS = 5000;
export const COPILOT_FRESH_MS = 8000;
export const flashedCopilotIds = new Set<string>();

export function commentBlockSelector(blockId: string): string {
  return `[data-block-id="${CSS.escape(blockId)}"]`;
}

export function compareCommentsByCreatedAt(a: Comment, b: Comment): number {
  return a.createdAt.localeCompare(b.createdAt);
}

export function hasCommentSourceDiverged(comment: Comment, scrollElement: HTMLElement | null) {
  if (!scrollElement) return false;
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
  const blockIds = commentBlockIds(comment);
  const textAnchor = getTextAnchorFromAnchor(comment.anchorJson);
  if (textAnchor) {
    if (blockIds.length === 0) return false;
    if (blockIds.some((id) => !scrollElement.querySelector(commentBlockSelector(id)))) return true;
    const liveText = normalize(
      blockIds
        .map((id) => scrollElement.querySelector(commentBlockSelector(id))?.textContent ?? '')
        .join(' '),
    );
    return !liveText.includes(normalize(textAnchor.text));
  }

  const snapshots = getBlockSnapshotsFromAnchor(comment.anchorJson);
  for (const snapshot of snapshots) {
    if (snapshot.blockId == null || !snapshot.blockText) continue;
    const element = scrollElement.querySelector(commentBlockSelector(snapshot.blockId));
    if (!element || normalize(element.textContent ?? '') !== normalize(snapshot.blockText)) return true;
  }
  return false;
}
