import type { ReactNode } from 'react';
import { BrushIcon, type BrushIconName } from './BrushIcon';
import { KindMark } from './KindMark';
import type { KindMarkKind } from './kind-mark';

/** One way to start, written under the sentence: what to do and, when it has one, its shortcut. */
export interface EmptyStateHint {
  label: ReactNode;
  keys?: string;
}

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
  /** Ways to start, in rows: the action in the secondary ink, its shortcut in index type. */
  hints?: readonly EmptyStateHint[];
}

export function EmptyState({
  message,
  density = 'default',
  className = '',
  mark,
  icon,
  action,
  hints,
}: EmptyStateProps) {
  return (
    <div className={`empty-state empty-state--${density} ${className}`.trim()}>
      {mark ? (
        <KindMark kind={mark} hollow color="hsl(var(--ink-4))" className="empty-state__mark" />
      ) : icon ? (
        <BrushIcon name={icon} size={22} className="empty-state__icon" />
      ) : null}
      <span className="empty-state__message">{message}</span>
      {hints && hints.length > 0 && <EmptyStateHints hints={hints} />}
      {action && <div className="empty-state__action">{action}</div>}
    </div>
  );
}

/** The hint rows on their own (an empty chapter's paper uses them without a sentence). */
export function EmptyStateHints({ hints }: { hints: readonly EmptyStateHint[] }) {
  return (
    <div className="empty-state__hints">
      {hints.map((hint, index) =>
        hint.keys ? (
          <div key={index} className="empty-state__hint">
            <span className="empty-state__hint-label">{hint.label}</span>
            <span className="empty-state__hint-keys">{hint.keys}</span>
          </div>
        ) : (
          <div key={index} className="empty-state__hint empty-state__hint--wide">
            <span className="empty-state__hint-label">{hint.label}</span>
          </div>
        ),
      )}
    </div>
  );
}
