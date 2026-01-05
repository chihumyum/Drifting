interface MainTopBarProps {
  children?: React.ReactNode;
}

export function MainTopBar({ children }: MainTopBarProps) {
  const isMac = navigator.userAgent.includes('Mac');
  
  if (!isMac) {
    return null;
  }

  return (
    <div
      style={{
        height: 40,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        paddingLeft: 16,
        paddingRight: 16,
        flexShrink: 0,
        WebkitAppRegion: 'drag',
        borderBottom: '1px solid rgba(213, 213, 213, 0.05)',
      } as React.CSSProperties}
    >
      <div style={{ pointerEvents: 'none' }}>
        {children}
      </div>
    </div>
  );
}