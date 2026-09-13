import { memo, useCallback, useEffect, useLayoutEffect, useSyncExternalStore, type DragEvent, type MouseEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { canonicalWordCount, type BookNode } from '../../domain/book-node';
import type { StoryGraphDriftDrag } from './story-graph-drift-drag';

export interface StoryGraphDriftCardsProps {
  nodes: readonly BookNode[];
  totalDrifts: number;
  drag: StoryGraphDriftDrag;
  cardRefs: RefObject<Map<string, HTMLDivElement>>;
  linkSourceId: string | null;
  isNodeEdgeSelected(id: string): boolean;
  onClick(event: MouseEvent<HTMLDivElement>, node: BookNode): void;
  onContextMenu(event: MouseEvent<HTMLDivElement>, node: BookNode): void;
  onDoubleClick(node: BookNode): void;
}

interface DriftCardProps extends Pick<StoryGraphDriftCardsProps, 'cardRefs' | 'onClick' | 'onContextMenu' | 'onDoubleClick'> {
  node: BookNode;
  index: number;
  drag: StoryGraphDriftDrag;
  isLinkSource: boolean;
  isEdgeSelected: boolean;
  onDragStart(event: DragEvent<HTMLDivElement>, id: string, index: number): void;
  onDragOver(event: DragEvent<HTMLDivElement>, index: number): void;
  onDrop(event: DragEvent<HTMLDivElement>): void;
  onDragEnd(): void;
}

function DriftCard({ node, index, drag, cardRefs, isLinkSource, isEdgeSelected,
  onClick, onContextMenu, onDoubleClick, onDragStart, onDragOver, onDrop, onDragEnd,
}: DriftCardProps) {
  const subscribe = useCallback((listener: () => void) => drag.subscribeCard(index, listener), [drag, index]);
  const getSnapshot = useCallback(() => drag.getCardSnapshot(index), [drag, index]);
  const presentation = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const isDragged = presentation === 'dragged';
  const shift = isDragged ? '' : presentation;
  const { t } = useTranslation();
  const isResting = node.writingStatus === 'resting';
  return (
    <div
      key={node.id}
      ref={(el) => {
        if (el) cardRefs.current.set(node.id, el);
        else cardRefs.current.delete(node.id);
      }}
      className={[
        'drift-card',
        isLinkSource ? 'is-link-source' : '',
        isDragged ? 'is-dragged' : '',
        isResting ? 'is-resting' : '',
        isEdgeSelected ? 'is-edge-selected' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{
        transform: shift || undefined,
        cursor: 'grab',
        // CSS transition lives on the class; we only set the
        // transform value at render-time so the live shift
        // smoothly transitions when the drop target moves.
      }}
      draggable
      onDragStart={(event) => onDragStart(event, node.id, index)}
      onDragEnd={onDragEnd}
      onDragOver={(event) => onDragOver(event, index)}
      onDrop={onDrop}
      onClick={(event) => onClick(event, node)}
      onContextMenu={(event) => onContextMenu(event, node)}
      onDoubleClick={() => onDoubleClick(node)}
      title={
        canonicalWordCount(node) == null
          ? t('storyGraph.drift.cardTitleCounting', {
              title: node.title || t('common.untitled'),
            })
          : t('storyGraph.drift.cardTitle', {
              title: node.title || t('common.untitled'),
              count: canonicalWordCount(node),
            })
      }
    >
      <div className="drift-card__num">§{String(node.bookOrder).padStart(2, '0')}</div>
      <div className="drift-card__title">{node.title || t('common.untitled')}</div>
      {node.summary && <div className="drift-card__summary">{node.summary}</div>}
    </div>
  );
}
const MemoDriftCard = memo(DriftCard);

function DriftCards({ nodes, totalDrifts, drag, cardRefs, linkSourceId, isNodeEdgeSelected,
  onClick, onContextMenu, onDoubleClick,
}: StoryGraphDriftCardsProps) {
  const { t } = useTranslation();
  useEffect(() => () => drag.cancel(), [drag]);
  useLayoutEffect(() => {
    const active = drag.getSnapshot().dragged;
    if (active && nodes[active.index]?.id !== active.id) drag.cancel();
  }, [drag, nodes]);
  const start = useCallback<DriftCardProps['onDragStart']>((event, id, index) => {
    drag.start(id, index);
    event.dataTransfer.effectAllowed = 'move';
    const rect = event.currentTarget.getBoundingClientRect();
    event.dataTransfer.setDragImage(event.currentTarget, rect.width / 2, rect.height / 2);
  }, [drag]);
  const over = useCallback<DriftCardProps['onDragOver']>((event, index) => {
    if (!drag.getSnapshot().dragged) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const rect = event.currentTarget.getBoundingClientRect();
    drag.hover(event.clientX - rect.left < rect.width / 2 ? index : index + 1);
  }, [drag]);
  const drop = useCallback<DriftCardProps['onDrop']>((event) => {
    if (!drag.getSnapshot().dragged) return;
    event.preventDefault(); event.stopPropagation();
    // Drift has no persistent order axis. Settle back using the card's CSS
    // transition; do not retain a FLIP that could run on a later data edit.
    drag.cancel();
  }, [drag]);
  if (nodes.length === 0) return <div className="drift-card__empty">{totalDrifts > 0
    ? t('storyGraph.drift.allAnchored') : t('storyGraph.drift.empty')}</div>;
  return <>{nodes.map((node, index) => {
    return <MemoDriftCard key={node.id} node={node} index={index} drag={drag} cardRefs={cardRefs}
      isLinkSource={linkSourceId === node.id} isEdgeSelected={isNodeEdgeSelected(node.id)}
      onClick={onClick} onContextMenu={onContextMenu} onDoubleClick={onDoubleClick}
      onDragStart={start} onDragOver={over} onDrop={drop} onDragEnd={drag.cancel} />;
  })}</>;
}

export const StoryGraphDriftCards = memo(DriftCards);
