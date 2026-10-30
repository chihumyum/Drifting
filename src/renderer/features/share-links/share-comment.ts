import type { Comment } from '../../domain/comment';

/** Metadata that marks a comment as a reader's comment from a share link. */
export interface ShareCommentMetadata {
  shareLink: { shareId: string };
}

export function isShareLinkComment(comment: Pick<Comment, 'authorKind' | 'metadataJson'>): boolean {
  if (comment.authorKind !== 'external' || !comment.metadataJson) return false;
  try {
    return Boolean((JSON.parse(comment.metadataJson) as Partial<ShareCommentMetadata>).shareLink);
  } catch {
    return false;
  }
}
