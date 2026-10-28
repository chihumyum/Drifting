import type { ReactNode } from 'react';
import { GhostIconButton } from './GhostIconButton';
import { BrushIcon } from './BrushIcon';

export interface DialogHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  description?: ReactNode;
  kicker?: ReactNode;
  onClose?: () => void;
  closeLabel?: string;
}

export function DialogHeader({
  title,
  subtitle,
  description,
  kicker,
  onClose,
  closeLabel = 'Close',
}: DialogHeaderProps) {
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
          icon={<BrushIcon name="close" size={16} />}
          onClick={onClose}
          title={closeLabel}
          aria-label={closeLabel}
        />
      )}
    </header>
  );
}

export function DialogBody({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`modal-body ${className}`.trim()}>{children}</div>;
}

export function DialogActions({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return <footer className={`modal-actions ${className}`.trim()}>{children}</footer>;
}
