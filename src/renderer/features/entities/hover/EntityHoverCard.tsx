import { Fragment, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useDataStoreFields } from '../../../store/use-data-store-fields';
import { buildEntityHoverCardContent, type EntityHoverCardContent, type EntityHoverTarget } from './entity-hover-card-model';
import type { EntityHoverCardPlacement } from '../../../components/ui/entity-hover-card-position';
import { KindMark } from '../../../components/ui/KindMark';
import {
  HoverCardHeading,
  HoverCardShell,
  type HoverActionGroup,
  type HoverCardPointerProps,
} from '../../../components/ui/HoverCard';

export function EntityHoverCard({
  target,
  anchor,
  placement = 'right-start',
  pointer,
  actions,
  onDismiss,
}: {
  target: EntityHoverTarget;
  anchor: HTMLElement;
  placement?: EntityHoverCardPlacement;
  /** From the owner's hover state, so the pointer can reach the actions. */
  pointer?: HoverCardPointerProps;
  /** What the thing's right-click menu used to offer, as the card's rows. */
  actions?: HoverActionGroup[];
  onDismiss?: () => void;
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
  const content = useMemo(() => buildEntityHoverCardContent(target, state, t), [state, t, target]);

  const hasActions = Boolean(actions?.some((group) => group.actions.length > 0));
  // A card that offers the writing status as a choice does not name it twice.
  const choosesStatus = Boolean(actions?.some((group) => group.key === 'status' && group.actions.length > 0));
  if (!content && !hasActions) return null;
  return (
    <HoverCardShell anchor={anchor} placement={placement} label={content?.title ?? undefined}
      pointer={pointer} actions={actions} onDismiss={onDismiss}>
      {content && <EntityHoverCardBody content={content} showStatus={!choosesStatus} />}
    </HoverCardShell>
  );
}

/**
 * A thing's head as every card shows it: its kind mark and title, its count
 * on the right, what it belongs to under them. The cards a press opens (a
 * Super View's chapter card) lead with it too.
 */
export function EntityHoverCardHead({ content, showStatus = false }: { content: EntityHoverCardContent; showStatus?: boolean }) {
  const tags = showStatus && content.status ? [{ text: content.status }, ...content.tags] : content.tags;
  return (
    <HoverCardHeading
      title={content.title}
      mark={{ ...content.mark, color: content.mark.color ?? undefined }}
      index={content.index}
      detail={tags.length > 0 ? tags.map((tag, index) => (
        <span key={`${tag.text}:${index}`}
          className={`hover-card__tag${tag.tone === 'secondary' ? ' hover-card__tag--soft' : ''}`}>
          {tag.mark && <KindMark kind={tag.mark.kind} color={tag.mark.color ?? undefined} seed={tag.mark.seed} loose={tag.mark.loose} />}
          {tag.text}
        </span>
      )) : undefined}
    />
  );
}

function EntityHoverCardBody({ content, showStatus }: { content: EntityHoverCardContent; showStatus: boolean }) {
  const summary = content.summary?.trim() ?? '';
  return (
    <>
      <EntityHoverCardHead content={content} showStatus={showStatus} />
      {summary && <div className="hover-card__text">{summary}</div>}
      {content.kv.length > 0 && (
        <dl className="hover-card__kv">
          {content.kv.map((row, index) => (
            <Fragment key={`${row.key}:${index}`}>
              <dt>{row.key}</dt>
              <dd>{row.value}</dd>
            </Fragment>
          ))}
        </dl>
      )}
    </>
  );
}
