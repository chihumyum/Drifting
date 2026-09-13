import { memo, type MouseEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { BookNode } from '../../domain/book-node';

export interface SuperElementDriftCardsProps {
  nodes: readonly BookNode[];
  linkSourceId: string | null;
  cardRefs: RefObject<Map<string, HTMLDivElement>>;
  onClick(event: MouseEvent<HTMLDivElement>, node: BookNode): void;
  onContextMenu(event: MouseEvent<HTMLDivElement>, node: BookNode): void;
}

function DriftCards({ nodes, linkSourceId, cardRefs, onClick, onContextMenu }: SuperElementDriftCardsProps) {
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
          onContextMenu={(event) => onContextMenu(event, node)}
          title={
            node.summary
              ? `${node.title || t('common.untitled')}\n\n${node.summary}`
              : node.title || t('common.untitled')
          }
        >
          <div className="drift-card__num">§{String(node.bookOrder).padStart(2, '0')}</div>
          <div className="drift-card__title">{node.title || t('common.untitled')}</div>
          {node.summary && <div className="drift-card__summary">{node.summary}</div>}
        </div>
      );
    })}
  </>;
}

export const SuperElementDriftCards = memo(DriftCards);
