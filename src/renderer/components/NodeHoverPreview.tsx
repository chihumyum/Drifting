import { useRef, useEffect } from 'react';
import type { BookNode } from '../domain/book_node';

interface NodeHoverPreviewProps {
  node: BookNode | null;
  position: { x: number; y: number } | null;
  showAbove?: boolean; // 是否显示在上方（用于 bottom timeline）
}

const MAX_HEIGHT = 400; // 最大高度（像素）

export function NodeHoverPreview({ node, position, showAbove = false }: NodeHoverPreviewProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    if (!contentRef.current || !node) return;

    // 处理鼠标滚轮事件，滚动浮窗内容
    const handleWheel = (e: WheelEvent) => {
      if (!contentRef.current) return;
      
      const scrollableContent = contentRef.current;
      const isScrollable = scrollableContent.scrollHeight > scrollableContent.clientHeight;
      
      if (isScrollable) {
        e.preventDefault();
        e.stopPropagation();
        scrollableContent.scrollTop += e.deltaY;
      }
    };

    // 将监听器添加到 window 上，捕获阶段
    window.addEventListener('wheel', handleWheel, { passive: false, capture: true });
    
    return () => {
      window.removeEventListener('wheel', handleWheel, { capture: true });
    };
  }, [node]);

  if (!node || !position) return null;

  return (
    <div
      style={{
        position: 'fixed',
        left: position.x,
        top: position.y,
        transform: showAbove ? 'translate(-50%, -100%)' : 'translateX(-50%)',
        width: 320,
        maxHeight: MAX_HEIGHT,
        background: '#fff',
        border: '1px solid rgba(0, 0, 0, 0.1)',
        borderRadius: 10,
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.12), 0 2px 6px rgba(0, 0, 0, 0.08)',
        zIndex: 10000,
        pointerEvents: 'auto', // 允许交互以支持滚动
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* 标题区域 - 固定不滚动 */}
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: 'rgba(0, 0, 0, 0.85)',
          padding: '12px 12px 8px 12px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          borderBottom: node.summary ? '1px solid rgba(0, 0, 0, 0.06)' : 'none',
          flexShrink: 0,
        }}
      >
        {node.title || 'Untitled Chapter'}
      </div>
      
      {/* 内容区域 - 可滚动 */}
      <div
        ref={contentRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: node.summary ? '8px 12px 12px 12px' : '0 12px 12px 12px',
          fontSize: 12,
          color: 'rgba(0, 0, 0, 0.6)',
          lineHeight: 1.5,
          // 自定义滚动条样式
          scrollbarWidth: 'thin',
          scrollbarColor: 'rgba(0, 0, 0, 0.2) transparent',
        }}
        // Webkit 浏览器的滚动条样式
        className="hover-preview-content"
      >
        {node.summary ? (
          <div style={{ whiteSpace: 'pre-wrap', wordWrap: 'break-word' }}>
            {node.summary}
          </div>
        ) : (
          <div
            style={{
              color: 'rgba(0, 0, 0, 0.35)',
              fontStyle: 'italic',
            }}
          >
            No summary
          </div>
        )}
      </div>
    </div>
  );
}
