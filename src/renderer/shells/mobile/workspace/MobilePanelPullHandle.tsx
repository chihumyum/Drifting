import { useRef, type PointerEvent as ReactPointerEvent } from 'react';

type PanelPosition = 'top' | 'bottom';

interface PullState {
  pointerId: number;
  startY: number;
  startExtent: number;
  latestExtent: number;
}

export function MobilePanelPullHandle({
  panel,
  extent,
  disabled = false,
  onExtentChange,
  onExtentCommit,
}: {
  panel: PanelPosition;
  extent: number;
  disabled?: boolean;
  onExtentChange: (panel: PanelPosition, extent: number) => void;
  onExtentCommit: (panel: PanelPosition, extent: number) => void;
}) {
  const pullRef = useRef<PullState | null>(null);

  const extentAt = (clientY: number) => {
    const pull = pullRef.current;
    if (!pull) return extent;
    const direction = panel === 'top' ? 1 : -1;
    return Math.max(
      0,
      Math.min(1, pull.startExtent + (direction * (clientY - pull.startY)) / window.innerHeight),
    );
  };

  const finish = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const pull = pullRef.current;
    if (!pull || pull.pointerId !== event.pointerId) return;
    const next = extentAt(event.clientY);
    pullRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    onExtentCommit(panel, next);
  };

  return (
    <button
      type="button"
      className={`m-panel-pull-handle m-panel-pull-handle--${panel}`}
      disabled={disabled}
      aria-label={panel === 'top' ? '下拉展开顶栏' : '上拉展开底栏'}
      onPointerDown={(event) => {
        if (disabled || (event.pointerType === 'mouse' && event.button !== 0)) return;
        event.preventDefault();
        event.stopPropagation();
        pullRef.current = {
          pointerId: event.pointerId,
          startY: event.clientY,
          startExtent: extent,
          latestExtent: extent,
        };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => {
        const pull = pullRef.current;
        if (!pull || pull.pointerId !== event.pointerId) return;
        event.preventDefault();
        const next = extentAt(event.clientY);
        pull.latestExtent = next;
        onExtentChange(panel, next);
      }}
      onPointerUp={finish}
      onPointerCancel={(event) => {
        const pull = pullRef.current;
        if (!pull || pull.pointerId !== event.pointerId) return;
        pullRef.current = null;
        onExtentCommit(panel, pull.latestExtent);
      }}
    >
      <span aria-hidden="true" />
    </button>
  );
}
