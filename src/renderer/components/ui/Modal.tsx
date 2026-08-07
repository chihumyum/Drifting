import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { DialogActions, DialogBody, DialogHeader } from './DialogContent';

interface ModalRootProps {
  children: ReactNode;
  onClose: () => void;
  ariaLabel?: string;
  closeOnBackdrop?: boolean;
  dismissOnEscape?: boolean;
  className?: string;
}

export function ModalRoot({
  children,
  onClose,
  ariaLabel,
  closeOnBackdrop = true,
  dismissOnEscape = true,
  className = '',
}: ModalRootProps) {
  useEffect(() => {
    if (!dismissOnEscape) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [dismissOnEscape, onClose]);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      className={`modal-root ${className}`.trim()}
      role="presentation"
      onMouseDown={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-root__dialog" role="dialog" aria-modal="true" aria-label={ariaLabel}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

interface ModalCardProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  width?: number | string;
}

export function ModalCard({ children, className = '', style, width = 520 }: ModalCardProps) {
  return (
    <div
      className={`modal-card ${className}`.trim()}
      style={{ width: typeof width === 'number' ? `${width}px` : width, ...style }}
    >
      {children}
    </div>
  );
}

export const ModalHeader = DialogHeader;
export const ModalBody = DialogBody;
export const ModalActions = DialogActions;
