import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { useDataStoreFields } from '../../../store/use-data-store-fields';
import { buildEntityHoverCardContent, type EntityHoverTarget } from './entity-hover-card-model';
import {
  computeEntityHoverCardPosition,
  type EntityHoverCardPlacement,
  type EntityHoverCardPosition,
} from '../../../components/ui/entity-hover-card-position';

export function EntityHoverCard({
  target,
  anchor,
  placement = 'right-start',
}: {
  target: EntityHoverTarget;
  anchor: HTMLElement;
  placement?: EntityHoverCardPlacement;
}) {
  const { t } = useTranslation();
  const state = useDataStoreFields(
    'bookNodes',
    'bookElements',
    'bookElementCategories',
    'storylines',
    'nodeStorylineMapping',
    'primaryStorylineByNode',
    'storylineNodeMapping',
    'driftGroups',
  );
  const cardRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<EntityHoverCardPosition | null>(null);
  const content = useMemo(() => buildEntityHoverCardContent(target, state, t), [state, t, target]);

  const updatePosition = useCallback(() => {
    const card = cardRef.current;
    if (!card || !anchor.isConnected) {
      setPosition(null);
      return;
    }
    const next = computeEntityHoverCardPosition({
      anchor: anchor.getBoundingClientRect(),
      card: { width: card.offsetWidth, height: card.scrollHeight },
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      placement,
    });
    setPosition((current) =>
      current &&
      current.top === next.top &&
      current.left === next.left &&
      current.maxHeight === next.maxHeight
        ? current
        : next,
    );
  }, [anchor, placement]);

  useLayoutEffect(() => {
    if (!content) return undefined;
    updatePosition();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(updatePosition);
    if (cardRef.current) observer.observe(cardRef.current);
    observer.observe(anchor);
    return () => observer.disconnect();
  }, [anchor, content, updatePosition]);

  useEffect(() => {
    if (!content) return undefined;
    const update = () => updatePosition();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [content, updatePosition]);

  useEffect(() => {
    if (!content) return undefined;
    const handleWheel = (event: WheelEvent) => {
      const body = contentRef.current;
      const targetNode = event.target instanceof Node ? event.target : null;
      if (!body || !targetNode || !anchor.contains(targetNode)) return;
      if (body.scrollHeight <= body.clientHeight) return;
      const canScroll =
        event.deltaY < 0
          ? body.scrollTop > 0
          : body.scrollTop + body.clientHeight < body.scrollHeight;
      if (!canScroll) return;
      event.preventDefault();
      event.stopPropagation();
      body.scrollTop += event.deltaY;
    };
    window.addEventListener('wheel', handleWheel, { passive: false, capture: true });
    return () => window.removeEventListener('wheel', handleWheel, { capture: true });
  }, [anchor, content]);

  if (!content) return null;
  const summary = content.summary?.trim() ?? '';

  return createPortal(
    <div
      ref={cardRef}
      role="tooltip"
      style={{
        position: 'fixed',
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        width: 300,
        maxWidth: 'calc(100vw - 24px)',
        maxHeight: position?.maxHeight ?? 720,
        visibility: position ? 'visible' : 'hidden',
        background: 'hsl(var(--surface))',
        border: '1px solid hsl(var(--rule-strong))',
        boxShadow: 'var(--entity-hover-card-shadow)',
        zIndex: 'var(--z-popover)',
        pointerEvents: 'none',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        fontFamily: 'var(--font-sans)',
      }}
    >
      <div
        ref={contentRef}
        className="hover-preview-content"
        style={{
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: '10px 12px',
          scrollbarWidth: 'thin',
          scrollbarColor: 'hsl(var(--rule-strong)) transparent',
        }}
      >
        {content.title && (
          <div
            style={{
              marginBottom: 8,
              color: 'hsl(var(--ink-1))',
              fontSize: 12.5,
              fontWeight: 600,
              lineHeight: 1.3,
              overflowWrap: 'anywhere',
            }}
          >
            {content.title}
          </div>
        )}
        {content.meta.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 5,
              marginBottom: 9,
            }}
          >
            {content.meta.map((item, index) => (
              <span
                key={`${item.text}:${index}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  minWidth: 0,
                  maxWidth: '100%',
                  padding: '2px 6px',
                  borderRadius: 1,
                  border:
                    item.tone === 'secondary'
                      ? '1px solid hsl(var(--rule) / 0.55)'
                      : '1px solid hsl(var(--rule))',
                  background:
                    item.tone === 'secondary' ? 'hsl(var(--paper) / 0.55)' : 'hsl(var(--paper))',
                  color: item.tone === 'secondary' ? 'hsl(var(--ink-4))' : 'hsl(var(--ink-3))',
                  fontSize: 10.5,
                  lineHeight: 1.35,
                  overflowWrap: 'anywhere',
                }}
              >
                {item.color && (
                  <span
                    aria-hidden
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: '50%',
                      flexShrink: 0,
                      background: item.color,
                      opacity: item.tone === 'secondary' ? 0.62 : 1,
                    }}
                  />
                )}
                {item.text}
              </span>
            ))}
          </div>
        )}
        <div
          style={{
            color: summary ? 'hsl(var(--ink-2))' : 'hsl(var(--ink-4))',
            fontSize: 11.5,
            fontStyle: summary ? 'normal' : 'italic',
            lineHeight: 1.55,
            overflowWrap: 'anywhere',
            whiteSpace: 'pre-wrap',
          }}
        >
          {summary || t('nodeHoverPreview.noSummary')}
        </div>
      </div>
    </div>,
    document.body,
  );
}
