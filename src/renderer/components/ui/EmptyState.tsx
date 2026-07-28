import type { ReactNode } from 'react';

interface EmptyStateProps {
  message: ReactNode;
  density?: 'compact' | 'default';
  className?: string;
}

export function EmptyState({
  message,
  density = 'default',
  className = '',
}: EmptyStateProps) {
  return (
    <div className={`empty-state empty-state--${density} ${className}`.trim()}>
      {message}
    </div>
  );
}
