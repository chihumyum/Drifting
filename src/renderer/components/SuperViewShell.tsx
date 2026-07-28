import type { HTMLAttributes, ReactNode } from 'react';

interface SuperViewShellProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

/**
 * Shared fixed window shell for every fullscreen super view. Feature classes
 * may add local tokens, but viewport geometry and shell behavior belong here.
 */
export function SuperViewShell({ className = '', children, ...props }: SuperViewShellProps) {
  return (
    <div className={['super-view-overlay', className].filter(Boolean).join(' ')} {...props}>
      {children}
    </div>
  );
}
