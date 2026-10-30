import type { HTMLAttributes, ReactNode } from 'react';
import { useSuperViewLeaving } from './super-view-leaving';

interface SuperViewShellProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

/**
 * Shared fixed window shell for every fullscreen super view. Feature classes
 * may add local tokens, but viewport geometry and shell behavior belong here.
 * A view a switch is pushing away stays on screen but takes no input.
 */
export function SuperViewShell({ className = '', children, ...props }: SuperViewShellProps) {
  const leaving = useSuperViewLeaving();
  return (
    <div
      className={['super-view-overlay', className].filter(Boolean).join(' ')}
      inert={leaving || undefined}
      aria-hidden={leaving || undefined}
      {...props}
    >
      {children}
    </div>
  );
}
