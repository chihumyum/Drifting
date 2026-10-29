import { memo, type MouseEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { BookNode } from '../../domain/book-node';

export interface SuperElementDriftCardsProps {
  nodes: readonly BookNode[];
  linkSourceId: string | null;
  cardRefs: RefObject<Map<string, HTMLDivElement>>;
  onClick(event: MouseEvent<HTMLDivElement>, node: BookNode): void;
  /** Resting on a card shows its hover card. */
  onPreviewEnter(event: MouseEvent<HTMLDivElement>, node: BookNode): void;
  onPreviewLeave(): void;
}

function DriftCards({ nodes, linkSourceId, cardRefs, onClick, onPreviewEnter, onPreviewLeave }: SuperElementDriftCardsProps) {
  const { t } = useTranslation();
  return <>
    {nodes.map((node) => {
      const isLinkSource = linkSourceId === node.id;
      const isResting = node.writingStatus === 'resting';
      return (
        <div
          key={node.id}
          data-super-card="node"
          data-node-id={node.id}
          className={`drift-card${isLinkSource ? ' is-link-source' : ''}${isResting ? ' is-resting' : ''}`}
          ref={(el) => {
            if (el) cardRefs.current.set(node.id, el);
            else cardRefs.current.delete(node.id);
          }}
          onClick={(event) => onClick(event, node)}
          onMouseEnter={(event) => onPreviewEnter(event, node)}
          onMouseLeave={onPreviewLeave}
        >
          <div className="drift-card__num">{t('nodeEditor.folio.drift')}</div>
          <div className="drift-card__title">{node.title || t('common.untitled')}</div>
          {node.summary && <div className="drift-card__summary">{node.summary}</div>}
        </div>
      );
    })}
  </>;
}

export const SuperElementDriftCards = memo(DriftCards);
