import type { ChapterNode, ChapterWritingStatus } from '../../domain/book-node';
import { ChapterEndMenu } from '../../components/editor/ChapterEndOrnament';
import { useChapterAgentReview } from './chapter-agent-review';

/**
 * The ⁂ menu wired to one chapter: insert the next chapter (the host decides
 * where the new chapter opens), toggle finished ↔ draft, and hand the chapter
 * to a background Agent review.
 */
export function ChapterEndActions({
  projectId,
  node,
  onInsertAfter,
  onSetStatus,
}: {
  projectId: string;
  node: ChapterNode;
  onInsertAfter: (nodeId: string) => void;
  onSetStatus: (nodeId: string, status: ChapterWritingStatus) => void;
}) {
  const review = useChapterAgentReview(projectId, node.id, node.title);
  const finished = node.writingStatus === 'finished';
  return (
    <ChapterEndMenu
      finished={finished}
      onInsert={() => onInsertAfter(node.id)}
      onToggleFinished={() => onSetStatus(node.id, finished ? 'draft' : 'finished')}
      reviewState={review.state}
      onReview={() => void review.run()}
    />
  );
}
