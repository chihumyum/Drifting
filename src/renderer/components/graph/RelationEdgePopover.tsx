import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { EntityRelationType } from '../../domain/entity-relation-type';
import type { EntityRelationLink } from '../../store/data-store';
import { useRelationTypePresentation } from '../../hooks/useRelationTypePresentation';
import { KindMark } from '../ui/KindMark';
import { HoverCardActions, HoverCardHeading } from '../ui/HoverCard';
import type { KindMarkKind } from '../ui/kind-mark';
import { computeAnchoredPopoverPosition } from '../ui/anchored-popover-position';
import '../../../styles/relation-edge-popover.css';

export interface RelationEdgePopoverAnchor {
  x: number;
  y: number;
}

interface RelationEdgePopoverProps {
  anchor: RelationEdgePopoverAnchor;
  relation: EntityRelationLink;
  relationType: EntityRelationType;
  sourceLabel: string;
  targetLabel: string;
  color: string;
  onDelete: () => void;
  /** Each end's sand mark in its own colour (a chapter's seal). */
  sourceMark?: ReactNode;
  targetMark?: ReactNode;
}

const ENDPOINT_MARK: Partial<Record<string, KindMarkKind>> = {
  node: 'chapter',
  element: 'element',
  category: 'category',
  storyline: 'storyline',
  library_item: 'material',
};

export function RelationEdgePopover({
  anchor,
  relation,
  relationType,
  sourceLabel,
  targetLabel,
  color,
  onDelete,
  sourceMark,
  targetMark,
}: RelationEdgePopoverProps) {
  const { t } = useTranslation();
  const presentRelationType = useRelationTypePresentation();
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const popover = popoverRef.current;
    if (!popover) return;
    const next = computeAnchoredPopoverPosition({
      anchor: {
        top: anchor.y,
        right: anchor.x,
        bottom: anchor.y,
        left: anchor.x,
        width: 0,
        height: 0,
      },
      popover: { width: popover.offsetWidth, height: popover.offsetHeight },
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      placement: 'top-start',
      offset: 10,
      viewportPadding: 10,
    });
    setPosition({ top: next.top, left: next.left });
  }, [anchor, relation.id, relationType]);

  if (typeof document === 'undefined') return null;

  const orientation = relationType.orientation;
  const presentation = presentRelationType(relationType);
  const endMark = (kind: string, id: string) => {
    const mark = ENDPOINT_MARK[kind];
    return mark ? <KindMark kind={mark} seed={id} /> : null;
  };

  // The hover card's own card (rounded desk card, resting glass edge): the type as its sand dash with the direction's word on the right,
  // each end under its role as a key and its mark and name as the value, the
  // description, then 删除关联 as the danger row.
  return createPortal(
    <div
      ref={popoverRef}
      className="relation-edge-popover--card entity-card-popover--card hover-card-surface"
      data-relation-edge-popover
      role="dialog"
      aria-label={t('storyGraph.edge.detailsTitle')}
      style={{
        width: 248,
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        visibility: position ? 'visible' : 'hidden',
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="hover-card__body">
        <HoverCardHeading
          title={presentation.name}
          mark={{ kind: 'storyline', color }}
          index={t(`relationTypes.${orientation}`)}
        />
        <dl className="hover-card__kv">
          <div className="hover-card__kv-row">
            <dt>{presentation.sourceRole}</dt>
            <dd className="hover-card__tag">{sourceMark ?? endMark(relation.fromKind, relation.fromId)}{sourceLabel}</dd>
          </div>
          <div className="hover-card__kv-row">
            <dt>{presentation.targetRole}</dt>
            <dd className="hover-card__tag">{targetMark ?? endMark(relation.toKind, relation.toId)}{targetLabel}</dd>
          </div>
        </dl>
        {presentation.description && (
          <div className="hover-card__text">{presentation.description}</div>
        )}
      </div>
      <HoverCardActions groups={[{
        key: 'relation',
        actions: [{
          key: 'delete',
          label: t('storyGraph.edge.delete'),
          icon: { brush: 'trash' },
          danger: true,
          keepOpen: true,
          onSelect: onDelete,
        }],
      }]} />
    </div>,
    document.body,
  );
}
