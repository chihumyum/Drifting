import type { BookNode } from '../../domain/book-node';
import { ChapterEditor } from './ChapterEditor';
import type { EntityLinkRef } from '../../lib/extensions/entity-link';

interface ChapterSectionProps {
  node: BookNode;
  projectId: string;
  content: string | null;
  onContentUpdate: (nodeId: string, pmJson: string, outlineJson: string) => void;
  isActive?: boolean;
  showDivider?: boolean;
  onEntityClick?: (ref: EntityLinkRef) => void;
}

export function ChapterSection({
  node,
  projectId,
  content,
  onContentUpdate,
  isActive = false,
  showDivider = true,
  onEntityClick,
}: ChapterSectionProps) {
  return (
    <div
      style={{
        background: 'rgba(251, 249, 243, 1)',
        borderBottom: showDivider ? '2px solid rgba(184, 153, 104, 0.3)' : 'none',
        position: 'relative',
      }}
    >
      {/* 当前章节指示器 */}
      {isActive && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: 4,
            background: 'rgba(184, 153, 104, 1)',
            zIndex: 10,
          }}
        />
      )}

      <ChapterEditor
        nodeId={node.id}
        projectId={projectId}
        content={content}
        title={node.title}
        summary={node.summary || ''}
        onContentUpdate={onContentUpdate}
        onEntityClick={onEntityClick}
        showTitle={true}
        showSummary={node.summary ? true : false}
        editableTitle={false}
        editableSummary={false}
        minHeight="300px"
        compact={true}
      />
    </div>
  );
}
