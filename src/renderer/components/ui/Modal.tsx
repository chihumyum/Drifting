import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { GhostIconButton } from './GhostIconButton';

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

interface ModalHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  description?: ReactNode;
  kicker?: ReactNode;
  onClose?: () => void;
  closeLabel?: string;
}

export function ModalHeader({
  title,
  subtitle,
  description,
  kicker,
  onClose,
  closeLabel = 'Close',
}: ModalHeaderProps) {
  return (
    <header className="modal-header">
      <div className="modal-header__copy">
        {kicker && <div className="modal-header__kicker">{kicker}</div>}
        <div className="modal-header__title">{title}</div>
        {subtitle && <div className="modal-header__subtitle">{subtitle}</div>}
        {description && <div className="modal-header__description">{description}</div>}
      </div>
      {onClose && (
        <GhostIconButton
          icon={<X size={16} strokeWidth={1.6} />}
          onClick={onClose}
          title={closeLabel}
          aria-label={closeLabel}
        />
      )}
    </header>
  );
}

export function ModalBody({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`modal-body ${className}`.trim()}>{children}</div>;
}

export function ModalActions({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return <footer className={`modal-actions ${className}`.trim()}>{children}</footer>;
}
