import type { DbClient } from '../../lib/db';
import { createCommentRepository } from '../../sqlite-repo/comment-repo';
import type { BookNodeAtomicTransactionRunner } from '../../usecase/book-node-write';

/**
 * Resolve every fourth sample TODO/comment, so the review lists show both
 * open and completed work. Same repository and authored transaction as
 * useComment.resolve; one transaction instead of one Agent call per comment.
 */
export async function resolveSampleComments(
  database: DbClient,
  runAtomic: BookNodeAtomicTransactionRunner,
  projectId: string,
): Promise<void> {
  const comments = await createCommentRepository(projectId, database).findAll();
  if (!comments.length) return;
  await runAtomic(projectId, async (tx, sync) => {
    const repository = createCommentRepository(projectId, tx);
    const resolvedAt = new Date().toISOString();
    for (const [index, comment] of comments.entries()) {
      if (index % 4 !== 0) continue;
      const persisted = await repository.update(comment.id, { status: 'resolved', resolvedAt, updatedAt: resolvedAt });
      if (!persisted) throw new Error('Sample comment disappeared during resolution');
      await sync('comment', 'update', comment.id, projectId, { status: persisted.status, resolvedAt: persisted.resolvedAt });
    }
  });
}
