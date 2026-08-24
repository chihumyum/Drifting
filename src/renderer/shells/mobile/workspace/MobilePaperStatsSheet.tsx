import { X } from 'lucide-react';
import { useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { isDrift } from '../../../domain/book-node';
import { EntityStatsContent } from '../../../features/stats/EntityStatsContent';
import type { EntityStatsTarget } from '../../../features/stats/entity-stats-types';
import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';
import { useDataStore } from '../../../store/data-store';
import { useMobilePaperPresentation } from './MobilePaperContent';

interface SheetDragState {
  pointerId: number;
  startY: number;
  latestY: number;
  latestTime: number;
  downwardVelocity: number;
}

function statsTarget(
  target: WorkspaceTarget,
  presentation: ReturnType<typeof useMobilePaperPresentation>,
  data: ReturnType<typeof useDataStore.getState>,
): EntityStatsTarget {
  if (target.entityType === 'all-chapters') {
    return {
      kind: 'all-chapters',
      id: null,
      title: presentation.title,
      kicker: presentation.kicker,
    };
  }
  if (target.entityType === 'node') {
    const node = data.bookNodes.find((item) => item.id === target.id);
    return {
      kind: node && isDrift(node) ? 'drift' : 'chapter',
      id: target.id,
      title: presentation.title,
      kicker: presentation.kicker,
      color: presentation.color,
    };
  }
  return {
    kind: target.entityType,
    id: target.id,
    title: presentation.title,
    kicker: presentation.kicker,
    color: presentation.color,
  };
}

export function MobilePaperStatsSheet({
  target,
  onClose,
}: {
  target: WorkspaceTarget;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const data = useDataStore();
  const presentation = useMobilePaperPresentation(target);
  const dragRef = useRef<SheetDragState | null>(null);
  const [dragOffset, setDragOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const currentTarget = statsTarget(target, presentation, data);

  const offsetFor = (clientY: number) => {
    const drag = dragRef.current;
    return drag ? Math.max(0, clientY - drag.startY) : dragOffset;
  };

  const sample = (clientY: number, timeStamp: number) => {
    const drag = dragRef.current;
    if (!drag) return dragOffset;
    const elapsed = timeStamp - drag.latestTime;
    if (elapsed > 0) {
      const velocity = (clientY - drag.latestY) / elapsed;
      drag.downwardVelocity = drag.downwardVelocity * 0.25 + velocity * 0.75;
    }
    drag.latestY = clientY;
    drag.latestTime = timeStamp;
    return offsetFor(clientY);
  };

  const finish = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const idleMs = event.timeStamp - drag.latestTime;
    const offset =
      Math.abs(event.clientY - drag.latestY) > 0.5
        ? sample(event.clientY, event.timeStamp)
        : offsetFor(event.clientY);
    const velocity = idleMs > 80 ? 0 : drag.downwardVelocity;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
    if (offset >= 96 || velocity >= 0.75) {
      onClose();
      return;
    }
    setDragOffset(0);
  };

  return (
    <div
      className="m-entity-preview-sheet m-paper-stats-sheet"
      role="presentation"
      data-dragging={dragging ? 'true' : 'false'}
      style={{ '--m-stats-sheet-offset': `${dragOffset}px` } as CSSProperties}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="m-paper-stats-title"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="m-paper-stats-sheet__grab"
          aria-label={t('mobileWorkspace.paperStats.dismiss', {
            defaultValue: '下拉关闭统计',
          })}
          onPointerDown={(event) => {
            if (event.pointerType === 'mouse' && event.button !== 0) return;
            event.preventDefault();
            dragRef.current = {
              pointerId: event.pointerId,
              startY: event.clientY,
              latestY: event.clientY,
              latestTime: event.timeStamp,
              downwardVelocity: 0,
            };
            event.currentTarget.setPointerCapture?.(event.pointerId);
            setDragging(true);
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== event.pointerId) return;
            event.preventDefault();
            setDragOffset(sample(event.clientY, event.timeStamp));
          }}
          onPointerUp={finish}
          onPointerCancel={() => {
            dragRef.current = null;
            setDragging(false);
            setDragOffset(0);
          }}
        >
          <span aria-hidden="true" />
        </button>
        <header>
          <div>
            <span style={{ background: presentation.color || 'hsl(var(--ink-4))' }} />
            <small>{t('rightSidebar.tabs.stats')}</small>
          </div>
          <button type="button" aria-label={t('common.close')} onClick={onClose}>
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        <div className="m-entity-preview-sheet__scroll m-paper-stats-sheet__content">
          <h2 id="m-paper-stats-title">{presentation.title}</h2>
          <EntityStatsContent
            target={currentTarget}
            bookNodes={data.bookNodes}
            bookActs={data.bookActs}
            bookElements={data.bookElements}
            storylines={data.storylines}
            categories={data.bookElementCategories}
            storylineNodeMapping={data.storylineNodeMapping}
            primaryStorylineByNode={data.primaryStorylineByNode}
          />
        </div>
      </section>
    </div>
  );
}
