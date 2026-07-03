import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import '../../../styles/timeline-pin-menu.css';

// Context menu shared by both timeline pins (BottomTimeline's TimelinePin and
// StoryGraphView's GraphTimelinePin). Owns the drift-binding actions:
//
//   unbound pin → 绑定漂浮节点…(opens DriftBindModal) / 重命名 / 删除
//   bound pin   → 打开漂浮节点 / 解绑（恢复为纯标签）/ 删除
//
// The bind picker is a standalone modal (DriftBindModal), not an inline
// submenu — the drift list can be long and cramps the menu. Portals to body
// (fixed positioning) to escape backdrop-filter containing blocks.
export interface TimelinePinMenuProps {
  x: number;
  y: number;
  isBound: boolean;
  onOpenDrift: () => void;
  onUnbind: () => void;
  /** Open the standalone drift-bind picker for this pin's marker. */
  onRequestBind: () => void;
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export function TimelinePinMenu({
  x,
  y,
  isBound,
  onOpenDrift,
  onUnbind,
  onRequestBind,
  onRename,
  onDelete,
  onClose,
}: TimelinePinMenuProps) {
  const { t } = useTranslation();
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
      {isBound ? (
        <>
          <button type="button" onClick={run(onOpenDrift)}>
            {t('bottomTimeline.pinMenu.openDrift')}
          </button>
          <button type="button" onClick={run(onUnbind)}>
            {t('bottomTimeline.pinMenu.unbind')}
          </button>
        </>
      ) : (
        <>
          <button type="button" onClick={run(onRequestBind)}>
            {t('bottomTimeline.pinMenu.bindDrift')}
          </button>
          <button type="button" onClick={run(onRename)}>
            {t('bottomTimeline.pinMenu.rename')}
          </button>
        </>
      )}
      <button type="button" className="is-danger" onClick={run(onDelete)}>
        {t('bottomTimeline.pinMenu.deleteMarker')}
      </button>
    </div>,
    document.body,
  );
}
