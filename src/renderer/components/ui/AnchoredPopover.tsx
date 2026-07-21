import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  computeAnchoredPopoverPosition,
  type AnchoredPopoverPlacement,
  type AnchoredPopoverPosition,
} from './anchored-popover-position';

interface AnchoredPopoverProps {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  placement?: AnchoredPopoverPlacement;
  offset?: number;
  viewportPadding?: number;
  maxHeight?: number;
  className?: string;
  style?: CSSProperties;
  role?: 'dialog' | 'menu' | 'listbox';
  ariaLabel?: string;
  autoFocus?: boolean;
  restoreFocus?: boolean;
  dismissOnOutside?: boolean;
  dismissOnEscape?: boolean;
  onContextMenu?: (event: React.MouseEvent<HTMLDivElement>) => void;
}

const FOCUSABLE_SELECTOR = [
  '[autofocus]',
  '[role="menuitem"]',
  '[role="option"]',
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableChildren(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true',
  );
}

/**
 * A non-modal anchored surface shared by menus, listboxes, and lightweight
 * dialogs. It portals to body and always uses viewport coordinates, so parent
 * overflow/backdrop-filter/stacking contexts cannot clip or displace it.
 */
export function AnchoredPopover({
  anchorRef,
  open,
  onClose,
  children,
  placement = 'bottom-start',
  offset = 6,
  viewportPadding = 8,
  maxHeight,
  className,
  style,
  role = 'dialog',
  ariaLabel,
  autoFocus = true,
  restoreFocus = true,
  dismissOnOutside = true,
  dismissOnEscape = true,
  onContextMenu,
}: AnchoredPopoverProps) {
  const localPopoverRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const [position, setPosition] = useState<AnchoredPopoverPosition | null>(null);

  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    const popover = localPopoverRef.current;
    if (!anchor || !popover) return;
    const anchorRect = anchor.getBoundingClientRect();
    const next = computeAnchoredPopoverPosition({
      anchor: anchorRect,
      popover: {
        width: popover.offsetWidth,
        height: popover.offsetHeight,
      },
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      placement,
      offset,
      viewportPadding,
    });
    setPosition((current) =>
      current &&
      current.top === next.top &&
      current.left === next.left &&
      current.maxHeight === next.maxHeight &&
      current.resolvedPlacement === next.resolvedPlacement
        ? current
        : next,
    );
  }, [anchorRef, offset, placement, viewportPadding]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    updatePosition();
    const popover = localPopoverRef.current;
    if (!popover) return undefined;
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(updatePosition);
    observer.observe(popover);
    return () => observer.disconnect();
  }, [children, open, updatePosition]);

  useEffect(() => {
    if (!open) return undefined;
    const update = () => updatePosition();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return undefined;
    const anchor = anchorRef.current;
    const popoverAtOpen = localPopoverRef.current;
    const activeBeforeOpen = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const frame = window.requestAnimationFrame(() => {
      if (!autoFocus) return;
      const popover = localPopoverRef.current;
      if (!popover || popover.contains(document.activeElement)) return;
      focusableChildren(popover)[0]?.focus({ preventScroll: true });
    });

    const handlePointerDown = (event: PointerEvent) => {
      if (!dismissOnOutside) return;
      const target = event.target as Node;
      if (localPopoverRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onCloseRef.current();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!dismissOnEscape || event.key !== 'Escape') return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        localPopoverRef.current?.contains(target) &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      if (!restoreFocus) return;
      const active = document.activeElement;
      if (
        active === document.body ||
        (active instanceof Node && popoverAtOpen?.contains(active))
      ) {
        (anchor ?? activeBeforeOpen)?.focus({ preventScroll: true });
      }
    };
  }, [anchorRef, autoFocus, dismissOnEscape, dismissOnOutside, open, restoreFocus]);

  const handlePopoverKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (role === 'dialog') return;
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') {
      return;
    }
    const popover = localPopoverRef.current;
    if (!popover) return;
    const items = focusableChildren(popover);
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
  };

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={localPopoverRef}
      className={className}
      role={role}
      aria-label={ariaLabel}
      data-placement={position?.resolvedPlacement ?? placement}
      onKeyDown={handlePopoverKeyDown}
      onContextMenu={onContextMenu}
      style={{
        ...style,
        position: 'fixed',
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        right: 'auto',
        bottom: 'auto',
        maxHeight: position ? Math.min(position.maxHeight, maxHeight ?? position.maxHeight) : maxHeight,
        maxWidth: `calc(100vw - ${viewportPadding * 2}px)`,
        visibility: position ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
