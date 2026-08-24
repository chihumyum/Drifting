import { getPlatformRuntime } from '../../platform/runtime';

interface MainTopBarProps {
  children?: React.ReactNode;
  leftContent?: React.ReactNode;
}

export function MainTopBar({ children, leftContent }: MainTopBarProps) {
  const { desktopWindowControls } = getPlatformRuntime();

  return (
    <div
      data-tauri-drag-region={desktopWindowControls ? 'deep' : undefined}
      style={
        {
          height: 'var(--window-titlebar-height)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingLeft: 0,
          paddingRight: 12,
          flexShrink: 0,
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
        }}
      >
        {leftContent}
      </div>

      {/* The center keeps an explicit Tauri drag region. Interactive tab
          descendants do not carry the attribute, so clicks and reorder
          gestures remain normal pointer interactions. */}
      <div
        data-tauri-drag-region={desktopWindowControls ? 'deep' : undefined}
        style={{
          pointerEvents: 'auto',
          flex: 1,
          display: 'flex',
          justifyContent: 'flex-start',
          minWidth: 0,
          overflow: 'hidden',
        }}
      >
        {children}
      </div>
    </div>
  );
}
