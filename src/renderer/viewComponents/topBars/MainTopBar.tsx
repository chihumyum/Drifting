interface MainTopBarProps {
  children?: React.ReactNode;
  leftContent?: React.ReactNode;
  rightContent?: React.ReactNode;
}

export function MainTopBar({ children, leftContent, rightContent }: MainTopBarProps) {
  const isMac = navigator.userAgent.includes('Mac');

  if (!isMac) {
    return null;
  }

  return (
    <div
      style={{
        height: 42,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingLeft: 16,
        paddingRight: 16,
        flexShrink: 0,
        WebkitAppRegion: 'drag',
        borderBottom: '1px solid rgba(213, 213, 213, 0.05)',
        border: '2px solid rgba(0, 0, 0, 1)',
      } as React.CSSProperties}
    >
      {/* Left content */}
      <div style={{ pointerEvents: 'auto', display: 'flex', alignItems: 'center', WebkitAppRegion: 'no-drag' }}>
        {leftContent}
      </div>

      {/* Center content */}
      <div style={{ pointerEvents: 'auto', flex: 1, display: 'flex', justifyContent: 'flex-start', minWidth: 0, overflow: 'hidden', WebkitAppRegion: 'no-drag' }}>
        {children}
      </div>

      {/* Right content */}
      <div style={{ pointerEvents: 'auto', display: 'flex', alignItems: 'center', WebkitAppRegion: 'no-drag' }}>
        {rightContent}
      </div>
    </div>
  );
}
