import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import '../../../styles/timeline-pin-menu.css';

// Context menu shared by both timeline pins (BottomTimeline's TimelinePin and
// StoryGraphView's GraphTimelinePin). Owns the drift-binding actions:
//
//   unbound pin → 绑定漂浮节点…(picker) / 重命名 / 删除
//   bound pin   → 打开漂浮节点 / 解绑（恢复为纯标签）/ 删除
//
// The picker lists drifts NOT already bound to some marker — bound-ness is
// derived from the marker table (see domain/timeline-marker.ts), so a drift
// freed by deleting its marker shows up here again immediately. Portals to
// body (fixed positioning) to escape backdrop-filter containing blocks.
export interface TimelinePinMenuProps {
  x: number;
  y: number;
  isBound: boolean;
  unboundDrifts: Array<{ id: string; title: string }>;
  onOpenDrift: () => void;
  onUnbind: () => void;
  onBind: (driftId: string) => void;
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export function TimelinePinMenu({
  x,
  y,
  isBound,
  unboundDrifts,
  onOpenDrift,
  onUnbind,
  onBind,
  onRename,
  onDelete,
  onClose,
}: TimelinePinMenuProps) {
  const [view, setView] = useState<'root' | 'pick'>('root');

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('.tlpin-menu')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };

  return createPortal(
    <div
      className="tlpin-menu"
      style={{ position: 'fixed', left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {view === 'root' ? (
        <>
          {isBound ? (
            <>
              <button type="button" onClick={run(onOpenDrift)}>
                打开漂浮节点
              </button>
              <button type="button" onClick={run(onUnbind)}>
                解绑（恢复为纯标签）
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                disabled={unboundDrifts.length === 0}
                title={
                  unboundDrifts.length === 0
                    ? '没有可绑定的漂浮节点（都已绑定或不存在）'
                    : undefined
                }
                onClick={() => setView('pick')}
              >
                绑定漂浮节点…
              </button>
              <button type="button" onClick={run(onRename)}>
                重命名
              </button>
            </>
          )}
          <button type="button" className="is-danger" onClick={run(onDelete)}>
            删除标记
          </button>
        </>
      ) : (
        <>
          <button type="button" className="tlpin-menu__back" onClick={() => setView('root')}>
            ‹ 返回
          </button>
          <div className="tlpin-menu__list">
            {unboundDrifts.map((d) => (
              <button key={d.id} type="button" onClick={run(() => onBind(d.id))}>
                {d.title || '未命名'}
              </button>
            ))}
          </div>
        </>
      )}
    </div>,
    document.body,
  );
}
