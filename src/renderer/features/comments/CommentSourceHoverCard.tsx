import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { Comment } from '../../domain/comment';
import { computeEntityHoverCardPosition, type EntityHoverCardPosition } from '../../components/ui/entity-hover-card-position';
import { HoverCardActions, type HoverActionGroup, type HoverCardPointerProps } from '../../components/ui/HoverCard';
import { KindMark } from '../../components/ui/KindMark';
import { kindMarkOfTarget } from '../../components/ui/kind-mark';
import { getPlatformRuntime } from '../../platform/runtime';
import { useDataStoreFields } from '../../store/use-data-store-fields';
import { buildCommentSourcePreview, type CommentSourceRelation } from './comment-source-preview';
import { reviewTargetColor } from './review-groups';

/**
 * Where a review item or TODO comes from, beside its card. With `pointer` and
 * `actions` the card takes the pointer and carries the item's actions along
 * its bottom (there is no right-click menu); without them it is a passive
 * preview.
 */
export function CommentSourceHoverCard({ comment, relations, anchor, id, pointer, actions, onDismiss, autoFocus = false }: {
  comment: Comment;
  relations: CommentSourceRelation[];
  anchor: HTMLElement;
  id: string;
  pointer?: HoverCardPointerProps;
  actions?: HoverActionGroup[];
  onDismiss?: () => void;
  /** Opened from the ⋯ button: focus the first action, and hand focus back on close. */
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  const state = useDataStoreFields('bookNodes', 'bookElements', 'bookElementCategories', 'storylines', 'primaryStorylineByNode');
  // Desktop names each source by its sand mark; the paused mobile shell keeps the kind's word.
  const marks = !getPlatformRuntime().isMobileShell;
  const source = useMemo(() => buildCommentSourcePreview(comment, relations, state, t), [comment, relations, state, t]);
  const groups = (actions ?? []).filter((group) => group.actions.length > 0);
  const interactive = Boolean(pointer);
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

  // The card is portaled to the end of the page, out of the tab order: asked
  // for from the keyboard, it takes focus once it is placed (a hidden button
  // cannot be focused) and gives it back when it closes.
  const returnFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const card = cardRef.current;
    if (!autoFocus || !position || !card || returnFocusRef.current) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
    card.querySelector<HTMLElement>('.hover-card__action:not(:disabled)')?.focus({ preventScroll: true });
  }, [autoFocus, position]);
  useLayoutEffect(() => {
    const card = cardRef.current;
    return () => {
      const previous = returnFocusRef.current;
      if (previous?.isConnected && card?.contains(document.activeElement)) previous.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <div id={id} role={interactive ? 'group' : 'tooltip'} ref={cardRef}
      className={`comment-source-hover${interactive ? ' comment-source-hover--interactive' : ''}`}
      onMouseEnter={pointer?.onMouseEnter} onMouseLeave={pointer?.onMouseLeave}
      style={{ top: position?.top ?? 0, left: position?.left ?? 0, maxHeight: position?.maxHeight ?? 420, visibility: position ? 'visible' : 'hidden' }}>
      <div ref={contentRef} className="comment-source-hover__content hover-card__body hover-preview-content">
        <div className="comment-source-hover__label">{t('reviewPanel.sourceInfo')}</div>
        {source.entities.length ? source.entities.map((entity) => (
          <div key={entity.key} className={`comment-source-hover__entity${marks ? ' comment-source-hover__entity--mark' : ''}`}>
            {marks && entity.targetKind !== 'patch'
              ? <KindMark kind={kindMarkOfTarget(entity.targetKind, entity.isDrift)} seed={entity.targetId}
                  color={reviewTargetColor(state, state.primaryStorylineByNode, entity.targetKind, entity.targetId)} title={entity.kind} />
              : <span>{entity.kind}</span>}
            <strong>{entity.name}</strong>
          </div>
        )) : <div className="comment-source-hover__empty">{t('reviewPanel.sourceFloating')}</div>}
        {source.hasTextAnchor && <>
          <div className="comment-source-hover__label comment-source-hover__text-label">{t('reviewPanel.sourceText')}</div>
          <div className="comment-source-hover__text">{source.text || t('reviewPanel.sourceTextUnavailable')}</div>
        </>}
      </div>
      {groups.length > 0 && <HoverCardActions groups={groups} onDone={onDismiss} />}
    </div>, document.body,
  );
}
