/**
 * A paragraph that the author changed both in Drifting and in the Markdown
 * folder at the same spot is merged without losing a character, but the
 * sentence may read as two edits spliced together. It gets one open TODO so
 * the author looks at it (docs/markdown-mirror.md).
 */
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { createPlainCommentDoc, type Comment } from '../../domain/comment';
import { getDb } from '../../lib/db';
import { events } from '../../lib/events';
import { i18next } from '../../lib/i18n';
import { CommentTable } from '../../schema/drizzle';
import { createCommentWithSync } from '../../usecase/synced-entity-commands';

/** `metadataJson` marker of these TODOs; one open card per paragraph. */
export interface MarkdownFolderCommentMetadata {
  markdownFolder: { path: string };
}

function isMarkdownFolderComment(metadataJson: string | null): boolean {
  if (!metadataJson) return false;
  try {
    return Boolean((JSON.parse(metadataJson) as Partial<MarkdownFolderCommentMetadata>).markdownFolder);
  } catch {
    return false;
  }
}

export async function flagOverlappingEdits(input: {
  projectId: string;
  nodeId: string;
  path: string;
  overlapped: readonly { blockId: string; text: string }[];
}): Promise<number> {
  if (input.overlapped.length === 0) return 0;
  const open = await getDb()
    .select({ blockId: CommentTable.targetBlockId, metadataJson: CommentTable.metadataJson })
    .from(CommentTable)
    .where(
      and(
        eq(CommentTable.projectId, input.projectId),
        eq(CommentTable.targetKind, 'node'),
        eq(CommentTable.targetId, input.nodeId),
        eq(CommentTable.status, 'open'),
      ),
    );
  const flagged = new Set(open.filter((row) => isMarkdownFolderComment(row.metadataJson)).map((row) => row.blockId));
  let created = 0;
  for (const { blockId, text } of input.overlapped) {
    if (flagged.has(blockId)) continue;
    const now = new Date().toISOString();
    const comment: Comment = {
      id: uuidv7(),
      projectId: input.projectId,
      kind: 'todo',
      targetKind: 'node',
      targetId: input.nodeId,
      targetBlockId: blockId,
      anchorJson: JSON.stringify({ createdAt: now, blockText: text, blockSnapshots: [{ blockId, blockText: text }] }),
      authorKind: 'external',
      authorId: null,
      authorName: i18next.t('notifications.markdownFolder.source'),
      bodyJson: createPlainCommentDoc(i18next.t('notifications.markdownFolder.overlap')),
      status: 'open',
      priority: null,
      source: 'api',
      metadataJson: JSON.stringify({ markdownFolder: { path: input.path } } satisfies MarkdownFolderCommentMetadata),
      targetBlockIdsJson: JSON.stringify([blockId]),
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await createCommentWithSync(comment);
    flagged.add(blockId);
    created += 1;
  }
  if (created) events.emit('sync:project-changed', { projectId: input.projectId, projectionImpact: 'workspace' });
  return created;
}
