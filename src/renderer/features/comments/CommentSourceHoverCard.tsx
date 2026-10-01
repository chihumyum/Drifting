import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { Comment } from '../../domain/comment';
import { computeEntityHoverCardPosition, type EntityHoverCardPosition } from '../../components/ui/entity-hover-card-position';
import { useDataStoreFields } from '../../store/use-data-store-fields';
import { buildCommentSourcePreview, type CommentSourceRelation } from './comment-source-preview';

export function CommentSourceHoverCard({ comment, relations, anchor, id }: {
  comment: Comment;
  relations: CommentSourceRelation[];
  anchor: HTMLElement;
  id: string;
}) {
  const { t } = useTranslation();
  const state = useDataStoreFields('bookNodes', 'bookElements', 'bookElementCategories', 'storylines');
  const source = useMemo(() => buildCommentSourcePreview(comment, relations, state, t), [comment, relations, state, t]);
  const cardRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<EntityHoverCardPosition | null>(null);
  const updatePosition = useCallback(() => {
    const card = cardRef.current;
    if (!card || !anchor.isConnected) { setPosition(null); return; }
    const next = computeEntityHoverCardPosition({
      anchor: anchor.getBoundingClientRect(), card: { width: card.offsetWidth, height: card.scrollHeight + card.offsetHeight - card.clientHeight },
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, placement: 'right-start', maxHeight: 420,
    });
    setPosition((current) => current?.top === next.top && current.left === next.left && current.maxHeight === next.maxHeight ? current : next);
  }, [anchor]);
  useLayoutEffect(() => {
    updatePosition();
    const observer = new ResizeObserver(updatePosition);
    observer.observe(anchor);
    if (cardRef.current) observer.observe(cardRef.current);
    return () => observer.disconnect();
  }, [anchor, source, updatePosition]);
  useEffect(() => {
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    // Like entity previews, keep the pointer over the card and wheel to read a long excerpt.
    const wheel = (event: WheelEvent) => {
      const body = contentRef.current;
      if (!body || !(event.target instanceof Node) || !anchor.contains(event.target)) return;
      const canScroll = event.deltaY < 0 ? body.scrollTop > 0 : body.scrollTop + body.clientHeight < body.scrollHeight;
      if (!canScroll) return;
      event.preventDefault();
      event.stopPropagation();
      body.scrollTop += event.deltaY;
    };
    window.addEventListener('wheel', wheel, { passive: false, capture: true });
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('wheel', wheel, { capture: true });
    };
  }, [anchor, updatePosition]);
  return createPortal(
    <div id={id} role="tooltip" className="comment-source-hover" ref={cardRef}
      style={{ top: position?.top ?? 0, left: position?.left ?? 0, maxHeight: position?.maxHeight ?? 420, visibility: position ? 'visible' : 'hidden' }}>
      <div ref={contentRef} className="comment-source-hover__content hover-preview-content">
        <div className="comment-source-hover__label">{t('reviewPanel.sourceInfo')}</div>
        {source.entities.length ? source.entities.map((entity) => (
          <div key={entity.key} className="comment-source-hover__entity">
            <span>{entity.kind}</span><strong>{entity.name}</strong>
          </div>
        )) : <div className="comment-source-hover__empty">{t('reviewPanel.sourceFloating')}</div>}
        {source.hasTextAnchor && <>
          <div className="comment-source-hover__label comment-source-hover__text-label">{t('reviewPanel.sourceText')}</div>
          <div className="comment-source-hover__text">{source.text || t('reviewPanel.sourceTextUnavailable')}</div>
        </>}
      </div>
    </div>, document.body,
  );
}
