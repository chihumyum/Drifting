import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { Comment } from '../../domain/comment';
import { HoverCardHeading, HoverCardShell, type HoverActionGroup, type HoverCardPointerProps } from '../../components/ui/HoverCard';
import { kindMarkOfTarget } from '../../components/ui/kind-mark';
import { getPlatformRuntime } from '../../platform/runtime';
import { useDataStoreFields } from '../../store/use-data-store-fields';
import { buildCommentSourcePreview, type CommentSourceRelation } from './comment-source-preview';
import { reviewTargetColor } from './review-groups';

/**
 * Where a review item or TODO comes from, beside its card: each source as a
 * head (its kind mark and name), then the passage it is bound to on a slip
 * of paper. With `pointer` and `actions` the card takes the pointer and
 * carries the item's rows (there is no right-click menu); without them it is
 * a passive preview.
 */
export function CommentSourceHoverCard({ comment, relations, anchor, id, pointer, actions, onDismiss, autoFocus = false }: {
  comment: Comment;
  relations: CommentSourceRelation[];
  anchor: HTMLElement;
  id: string;
  pointer?: HoverCardPointerProps;
  actions?: HoverActionGroup[];
  onDismiss?: () => void;
  /** Opened from the ⋯ button: focus the first row, and hand focus back on close. */
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  const state = useDataStoreFields('bookNodes', 'bookElements', 'bookElementCategories', 'storylines', 'primaryStorylineByNode');
  // Desktop names each source by its sand mark; the paused mobile shell keeps the kind's word.
  const marks = !getPlatformRuntime().isMobileShell;
  const source = useMemo(() => buildCommentSourcePreview(comment, relations, state, t), [comment, relations, state, t]);

  return (
    <HoverCardShell anchor={anchor} id={id} maxHeight={420} label={t('reviewPanel.sourceInfo')}
      pointer={pointer} actions={actions} onDismiss={onDismiss} autoFocus={autoFocus}>
      {source.entities.length ? source.entities.map((entity) => (
        <HoverCardHeading
          key={entity.key}
          title={entity.name}
          mark={marks && entity.targetKind !== 'patch' ? {
            kind: kindMarkOfTarget(entity.targetKind, entity.isDrift),
            seed: entity.targetId,
            color: reviewTargetColor(state, state.primaryStorylineByNode, entity.targetKind, entity.targetId),
          } : undefined}
          index={marks && entity.targetKind !== 'patch' ? undefined : entity.kind}
        />
      )) : (
        <div className="hover-card__head">
          <span className="hover-card__title hover-card__title--quiet">{t('reviewPanel.sourceFloating')}</span>
        </div>
      )}
      {source.hasTextAnchor && (
        <div className="hover-card__quote">{source.text || t('reviewPanel.sourceTextUnavailable')}</div>
      )}
    </HoverCardShell>
  );
}
