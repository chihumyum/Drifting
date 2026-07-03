import { useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { BookNode } from '../domain/book-node';

interface NodeHoverPreviewProps {
  node: BookNode | null;
  position: { x: number; y: number } | null;
  showAbove?: boolean; // 是否显示在上方（用于 bottom timeline）
}

const MAX_HEIGHT = 240;
const MAX_WIDTH = 280;

export function NodeHoverPreview({ node, position, showAbove = false }: NodeHoverPreviewProps) {
  const { t } = useTranslation();
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!contentRef.current || !node) return;

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

    window.addEventListener('wheel', handleWheel, { passive: false, capture: true });

    return () => {
      window.removeEventListener('wheel', handleWheel, { capture: true });
    };
  }, [node]);

  if (!node || !position) return null;

  const summary = node.summary?.trim() ?? '';

  return (
    <div
      style={{
        position: 'fixed',
        left: position.x,
        top: position.y,
        transform: showAbove ? 'translate(-50%, -100%)' : 'translateX(-50%)',
        maxWidth: MAX_WIDTH,
        maxHeight: MAX_HEIGHT,
        background: 'hsl(var(--surface))',
        border: '1px solid hsl(var(--rule-strong))',
        boxShadow: '0 6px 18px hsl(var(--ink-1) / 0.15)',
        zIndex: 10000,
        pointerEvents: 'auto',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        fontFamily: 'var(--font-sans)',
      }}
    >
      <div
        ref={contentRef}
        style={{
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: '8px 10px',
          fontSize: 11.5,
          color: summary ? 'hsl(var(--ink-2))' : 'hsl(var(--ink-4))',
          lineHeight: 1.45,
          scrollbarWidth: 'thin',
          scrollbarColor: 'hsl(var(--rule-strong)) transparent',
          fontStyle: summary ? 'normal' : 'italic',
        }}
        className="hover-preview-content"
      >
        {summary ? (
          <div style={{ whiteSpace: 'pre-wrap', wordWrap: 'break-word' }}>{summary}</div>
        ) : (
          <div>{t('nodeHoverPreview.noSummary')}</div>
        )}
      </div>
    </div>
  );
}
