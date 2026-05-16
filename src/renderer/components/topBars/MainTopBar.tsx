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
      style={
        {
          height: 42,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingLeft: 12,
          paddingRight: 12,
          flexShrink: 0,
          WebkitAppRegion: 'drag',
          borderBottom: '1px solid hsl(var(--rule))',
        } as React.CSSProperties
      }
    >
      {/* Left content */}
      <div
        style={{
          pointerEvents: 'auto',
          display: 'flex',
          alignItems: 'center',
          WebkitAppRegion: 'no-drag',
        }}
      >
        {leftContent}
      </div>

      {/* Center content */}
      <div
        style={{
          pointerEvents: 'auto',
          flex: 1,
          display: 'flex',
          justifyContent: 'flex-start',
          minWidth: 0,
          overflow: 'hidden',
          WebkitAppRegion: 'no-drag',
        }}
      >
        {children}
      </div>

      {/* Right content */}
      <div
        style={{
          pointerEvents: 'auto',
          display: 'flex',
          alignItems: 'center',
          WebkitAppRegion: 'no-drag',
        }}
      >
        {rightContent}
      </div>
    </div>
  );
}
