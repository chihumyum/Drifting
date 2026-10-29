import type { ReactNode } from 'react';
import { BrushIcon, type BrushIconName } from './BrushIcon';
import { KindMark } from './KindMark';
import type { KindMarkKind } from './kind-mark';

interface EmptyStateProps {
  message: ReactNode;
  density?: 'compact' | 'default';
  className?: string;
  /** What is missing is a kind of thing: its hollow mark sits above the sentence. */
  mark?: KindMarkKind;
  /** Otherwise a faint brush icon of the place (the notification bell). */
  icon?: BrushIconName;
  /** A text button that makes the missing thing right here. */
  action?: ReactNode;
}

export function EmptyState({
  message,
  density = 'default',
  className = '',
  mark,
  icon,
  action,
}: EmptyStateProps) {
  return (
    <div className={`empty-state empty-state--${density} ${className}`.trim()}>
      {mark ? (
        <KindMark kind={mark} hollow color="hsl(var(--ink-4))" className="empty-state__mark" />
      ) : icon ? (
        <BrushIcon name={icon} size={22} className="empty-state__icon" />
      ) : null}
      <span className="empty-state__message">{message}</span>
      {action && <div className="empty-state__action">{action}</div>}
    </div>
  );
}
