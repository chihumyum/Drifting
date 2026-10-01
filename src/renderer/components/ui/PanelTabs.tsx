import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';

interface PanelTabTrayProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export const PanelTabTray = forwardRef<HTMLDivElement, PanelTabTrayProps>(function PanelTabTray(
  { className = '', children, ...props },
  ref,
) {
  return (
    <div ref={ref} className={`panel-tab-tray ${className}`.trim()} {...props}>
      {children}
    </div>
  );
});

interface PanelTabProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active: boolean;
  typography?: 'label' | 'caps';
}

/**
 * Shared sidebar panel tab. Both sidebars use a real button with identical
 * geometry; labels and activity content remain caller slots.
 */
export function PanelTab({
  active,
  typography = 'caps',
  className = '',
  children,
  ...props
}: PanelTabProps) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={[
        'app-panel-tab',
        `app-panel-tab--${typography}`,
        active ? 'is-active' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...props}
    >
      {children}
    </button>
  );
}
