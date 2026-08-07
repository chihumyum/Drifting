import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { computePointSurfacePosition } from './point-surface-position';

interface ContextMenuSurfaceProps {
  x: number;
  y: number;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  viewportPadding?: number;
  dismissOnScroll?: boolean;
  ariaLabel?: string;
  role?: 'menu' | 'dialog' | 'listbox';
}

function menuItems(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [role="menuitem"]:not([aria-disabled="true"])',
    ),
  ).filter((item) => item.tabIndex !== -1);
}

/**
 * Shared cursor-anchored portal surface for every context menu. It owns
 * viewport clamping, outside/Escape dismissal, and keyboard item traversal.
 */
export function ContextMenuSurface({
  x,
  y,
  onClose,
  children,
  className,
  style,
  viewportPadding = 8,
  dismissOnScroll = false,
  ariaLabel,
  role = 'menu',
}: ContextMenuSurfaceProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const [position, setPosition] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const updatePosition = useCallback(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const next = computePointSurfacePosition({
      x,
      y,
      width: surface.offsetWidth,
      height: surface.offsetHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      viewportPadding,
    });
    setPosition((current) =>
      current.left === next.left && current.top === next.top ? current : next,
    );
  }, [viewportPadding, x, y]);

  useLayoutEffect(() => {
    updatePosition();
    const surface = surfaceRef.current;
    if (!surface || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(updatePosition);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [children, updatePosition]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (surfaceRef.current?.contains(event.target as Node)) return;
      onCloseRef.current();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    const handleViewportChange = () => {
      if (dismissOnScroll) onCloseRef.current();
      else updatePosition();
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [dismissOnScroll, updatePosition]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={surfaceRef}
      className={['context-menu-surface', role === 'menu' ? 'menu-surface' : null, className]
        .filter(Boolean)
        .join(' ')}
      role={role}
      aria-label={ariaLabel}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (
          event.key !== 'ArrowDown' &&
          event.key !== 'ArrowUp' &&
          event.key !== 'Home' &&
          event.key !== 'End'
        ) {
          return;
        }
        const surface = surfaceRef.current;
        if (!surface) return;
        const items = menuItems(surface);
        if (items.length === 0) return;
        event.preventDefault();
        const current = document.activeElement instanceof HTMLElement
          ? items.indexOf(document.activeElement)
          : -1;
        let next = current;
        if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = items.length - 1;
        else if (event.key === 'ArrowDown') next = current < items.length - 1 ? current + 1 : 0;
        else next = current > 0 ? current - 1 : items.length - 1;
        items[next]?.focus({ preventScroll: true });
      }}
      style={{
        ...style,
        position: 'fixed',
        left: position.left,
        top: position.top,
        right: 'auto',
        bottom: 'auto',
        maxWidth: `calc(100vw - ${viewportPadding * 2}px)`,
        maxHeight: `calc(100vh - ${viewportPadding * 2}px)`,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
