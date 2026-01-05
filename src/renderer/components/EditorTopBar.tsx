interface EditorTopBarProps {
  title?: string;
}

export function EditorTopBar({ title }: EditorTopBarProps) {
  const isMac = navigator.userAgent.includes('Mac');
  
  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: isMac ? 40 : 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
        zIndex: 100,
        WebkitAppRegion: 'drag',
        pointerEvents: 'auto', // 启用拖拽
      } as React.CSSProperties}
    >
      {title && (
        <div
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: 'rgba(0, 0, 0, 0.5)',
            userSelect: 'none',
            pointerEvents: 'none',
          }}
        >
          {title}
        </div>
      )}
    </div>
  );
}