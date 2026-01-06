import type { BookNode } from '../domain/book_node';

interface NodeHoverPreviewProps {
  node: BookNode | null;
  position: { x: number; y: number } | null;
  showAbove?: boolean; // 是否显示在上方（用于 bottom timeline）
}

export function NodeHoverPreview({ node, position, showAbove = false }: NodeHoverPreviewProps) {
  if (!node || !position) return null;

  return (
    <div
      style={{
        position: 'fixed',
        left: position.x,
        top: position.y,
        transform: showAbove ? 'translate(-50%, -100%)' : 'translateX(-50%)',
        width: 280,
        background: '#fff',
        border: '1px solid rgba(0, 0, 0, 0.1)',
        borderRadius: 10,
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.12), 0 2px 6px rgba(0, 0, 0, 0.08)',
        padding: 12,
        zIndex: 10000,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: 'rgba(0, 0, 0, 0.85)',
          marginBottom: 6,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {node.title || 'Untitled Chapter'}
      </div>
      {node.summary && (
        <div
          style={{
            fontSize: 12,
            color: 'rgba(0, 0, 0, 0.6)',
            lineHeight: 1.5,
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {node.summary}
        </div>
      )}
      {!node.summary && (
        <div
          style={{
            fontSize: 12,
            color: 'rgba(0, 0, 0, 0.35)',
            fontStyle: 'italic',
          }}
        >
          No summary
        </div>
      )}
    </div>
  );
}
