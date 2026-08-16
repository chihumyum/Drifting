import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { EntityRelationType } from '../../domain/entity-relation-type';
import type { EntityRelationLink } from '../../store/data-store';
import { useRelationTypePresentation } from '../../hooks/useRelationTypePresentation';
import { Button } from '../ui/Button';
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
}

export function RelationEdgePopover({
  anchor,
  relation,
  relationType,
  sourceLabel,
  targetLabel,
  color,
  onDelete,
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
  const flowGlyph = orientation === 'symmetric' ? '↔' : '→';

  return createPortal(
    <div
      ref={popoverRef}
      className="relation-edge-popover"
      data-relation-edge-popover
      role="dialog"
      aria-label={t('storyGraph.edge.detailsTitle')}
      style={{
        position: 'fixed',
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        visibility: position ? 'visible' : 'hidden',
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="relation-edge-popover__header">
        <span className="relation-edge-popover__dot" style={{ background: color }} />
        <strong>{presentation.name}</strong>
        <span className="relation-edge-popover__orientation">
          {t(`relationTypes.${orientation}`)}
        </span>
      </div>

      <div className="relation-edge-popover__flow">
        <div>
          <span>{presentation.sourceRole}</span>
          <strong>{sourceLabel}</strong>
          <small>{t(`relationTypes.entityKinds.${relation.fromKind}`)}</small>
        </div>
        <b aria-hidden>{flowGlyph}</b>
        <div>
          <span>{presentation.targetRole}</span>
          <strong>{targetLabel}</strong>
          <small>{t(`relationTypes.entityKinds.${relation.toKind}`)}</small>
        </div>
      </div>

      {presentation.description && (
        <p className="relation-edge-popover__description">{presentation.description}</p>
      )}

      <div className="relation-edge-popover__actions">
        <Button variant="danger" size="sm" onClick={onDelete}>
          {t('storyGraph.edge.delete')}
        </Button>
      </div>
    </div>,
    document.body,
  );
}
