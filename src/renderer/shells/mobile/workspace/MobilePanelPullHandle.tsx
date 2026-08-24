import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { MobilePanelGestureCommit } from './mobile-panel-gesture';

type PanelPosition = 'top' | 'bottom';
type PanelHandleVariant = 'entry' | 'boundary';

interface PullState {
  pointerId: number;
  startY: number;
  startExtent: number;
  latestExtent: number;
  latestY: number;
  latestTime: number;
  openingVelocityVhPerSecond: number;
}

export function MobilePanelPullHandle({
  panel,
  extent,
  variant = 'entry',
  disabled = false,
  onDragStateChange,
  onExtentChange,
  onExtentCommit,
}: {
  panel: PanelPosition;
  extent: number;
  variant?: PanelHandleVariant;
  disabled?: boolean;
  onDragStateChange?: (panel: PanelPosition, dragging: boolean) => void;
  onExtentChange: (panel: PanelPosition, extent: number) => void;
  onExtentCommit: (panel: PanelPosition, gesture: MobilePanelGestureCommit) => void;
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

  const sample = (clientY: number, timeStamp: number) => {
    const pull = pullRef.current;
    if (!pull) return extent;
    const next = extentAt(clientY);
    const elapsedMs = timeStamp - pull.latestTime;
    if (elapsedMs > 0) {
      const direction = panel === 'top' ? 1 : -1;
      const deltaExtent = (direction * (clientY - pull.latestY)) / window.innerHeight;
      const instantaneous = deltaExtent / (elapsedMs / 1000);
      pull.openingVelocityVhPerSecond =
        pull.openingVelocityVhPerSecond * 0.25 + instantaneous * 0.75;
    }
    pull.latestExtent = next;
    pull.latestY = clientY;
    pull.latestTime = timeStamp;
    return next;
  };

  const finish = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const pull = pullRef.current;
    if (!pull || pull.pointerId !== event.pointerId) return;
    const idleMs = event.timeStamp - pull.latestTime;
    const next =
      Math.abs(event.clientY - pull.latestY) > 0.5
        ? sample(event.clientY, event.timeStamp)
        : extentAt(event.clientY);
    const velocity = idleMs > 80 ? 0 : pull.openingVelocityVhPerSecond;
    pullRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
    onDragStateChange?.(panel, false);
    onExtentCommit(panel, {
      extent: next,
      openingVelocityVhPerSecond: velocity,
      travel: Math.abs(next - pull.startExtent),
    });
  };

  return (
    <button
      type="button"
      className={
        variant === 'entry'
          ? `m-panel-pull-handle m-panel-pull-handle--${panel}`
          : `m-context-workspace__handle m-context-workspace__handle--${panel}`
      }
      disabled={disabled}
      aria-label={
        variant === 'entry'
          ? panel === 'top'
            ? '下拉展开顶栏'
            : '上拉展开底栏'
          : panel === 'top'
            ? '调整顶部面板高度'
            : '调整底部面板高度'
      }
      onPointerDown={(event) => {
        if (disabled || (event.pointerType === 'mouse' && event.button !== 0)) return;
        event.preventDefault();
        event.stopPropagation();
        pullRef.current = {
          pointerId: event.pointerId,
          startY: event.clientY,
          startExtent: extent,
          latestExtent: extent,
          latestY: event.clientY,
          latestTime: event.timeStamp,
          openingVelocityVhPerSecond: 0,
        };
        onDragStateChange?.(panel, true);
        try {
          event.currentTarget.setPointerCapture?.(event.pointerId);
        } catch {
          // The iOS renderer debug bridge dispatches synthetic pointer events
          // without registering a native active pointer. Drag state and direct
          // event delivery still provide deterministic simulator acceptance.
        }
      }}
      onPointerMove={(event) => {
        const pull = pullRef.current;
        if (!pull || pull.pointerId !== event.pointerId) return;
        event.preventDefault();
        const next = sample(event.clientY, event.timeStamp);
        onExtentChange(panel, next);
      }}
      onPointerUp={finish}
      onPointerCancel={(event) => {
        const pull = pullRef.current;
        if (!pull || pull.pointerId !== event.pointerId) return;
        pullRef.current = null;
        onDragStateChange?.(panel, false);
        onExtentCommit(panel, {
          extent: pull.latestExtent,
          openingVelocityVhPerSecond: 0,
          travel: Math.abs(pull.latestExtent - pull.startExtent),
        });
      }}
    >
      <span aria-hidden="true" />
    </button>
  );
}
