import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { shouldDismissEntityCardPopoverOnKeyDown } from './entity-card-popover-dismissal';

export interface EntityCardAnchorRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface EntityCardPositionOptions {
  mode: 'default' | 'upgrade';
  anchorRect: EntityCardAnchorRect;
  popoverWidth: number;
  estimatedHeight: number;
  upgradeWidth?: number;
  upgradeHeightMax?: number;
  gap?: number;
}

export function computeEntityCardPosition({
  mode,
  anchorRect,
  popoverWidth,
  estimatedHeight,
  upgradeWidth = 640,
  upgradeHeightMax = 720,
  gap = 10,
}: EntityCardPositionOptions): CSSProperties {
  if (mode === 'upgrade') {
    return {
      width: upgradeWidth,
      height: Math.min(upgradeHeightMax, window.innerHeight - 64),
      left: '50%',
      top: '50%',
      transform: 'translate(-50%, -50%)',
    };
  }

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const anchorCenterX = anchorRect.left + anchorRect.width / 2;
  const left = Math.max(
    8,
    Math.min(anchorCenterX - popoverWidth / 2, viewportWidth - popoverWidth - 8),
  );
  const spaceAbove = anchorRect.top;
  const spaceBelow = viewportHeight - (anchorRect.top + anchorRect.height);

  if (spaceAbove >= estimatedHeight + gap || spaceAbove >= spaceBelow) {
    return {
      width: popoverWidth,
      left,
      bottom: viewportHeight - anchorRect.top + gap,
      maxHeight: Math.max(0, spaceAbove - gap - 8),
    };
  }

  const top = anchorRect.top + anchorRect.height + gap;
  return {
    width: popoverWidth,
    left,
    top,
    maxHeight: Math.max(0, viewportHeight - top - 8),
  };
}

interface EntityCardPopoverShellProps extends EntityCardPositionOptions {
  children: ReactNode;
  onClose: () => void;
  ariaLabel: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * Shared two-stage anchored-card surface for graph nodes and world elements.
 * Content/edit persistence stays feature-owned; placement and dismissal do not.
 */
export function EntityCardPopoverShell({
  children,
  onClose,
  ariaLabel,
  className = '',
  style,
  ...positionOptions
}: EntityCardPopoverShellProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Listen after the focused input / TipTap editor has had a chance to
      // consume Escape for its own transient state. An unhandled Escape means
      // "leave this card layer", even while contentEditable still has focus.
      if (!shouldDismissEntityCardPopoverOnKeyDown(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    const handleMouseDown = (event: MouseEvent) => {
      if (containerRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    const timeout = window.setTimeout(() => {
      window.addEventListener('mousedown', handleMouseDown);
    }, 0);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener('mousedown', handleMouseDown);
    };
  }, [onClose]);

  if (typeof document === 'undefined') return null;
  const position = computeEntityCardPosition(positionOptions);
  return createPortal(
    <>
      {positionOptions.mode === 'upgrade' && <div className="entity-card-backdrop" />}
      <div
        ref={containerRef}
        role="dialog"
        aria-label={ariaLabel}
        className={[
          'entity-card-popover',
          positionOptions.mode === 'upgrade' ? 'is-upgrade' : '',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
        style={{ ...position, ...style }}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}
