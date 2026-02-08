import { useUiStore } from '../../store/ui-store';

type RightPanelId = 'references' | 'inspirations' | 'ai';

const PANELS: Array<{ id: RightPanelId; label: string }> = [
  { id: 'references', label: '参考资料' },
  { id: 'inspirations', label: '灵感片段' },
  { id: 'ai', label: 'AI功能' },
];

interface RightSidebarHeaderProps {
  inline?: boolean;
}

export function RightSidebarHeader({ inline = false }: RightSidebarHeaderProps) {
  const activeRightPanel = useUiStore((state) => state.activeRightPanel);
  const setActiveRightPanel = useUiStore((state) => state.setActiveRightPanel);

  return (
    <div
      style={{
        display: 'flex',
        height: inline ? 28 : 40,
        width: '100%',
        alignItems: 'center',
        gap: 4,
        padding: inline ? 0 : '0 6px',
        borderBottom: inline ? 'none' : '1px solid rgba(213, 213, 213, 0.3)',
      }}
    >
      {PANELS.map((panel) => {
        const isActive = activeRightPanel === panel.id;
        return (
          <button
            key={panel.id}
            onClick={() => setActiveRightPanel(panel.id)}
            style={{
              flex: 1,
              height: 28,
              borderRadius: 6,
              border: isActive ? '1px solid rgba(184, 153, 104, 0.6)' : '1px solid rgba(184, 153, 104, 0.2)',
              background: isActive ? 'rgba(184, 153, 104, 0.16)' : 'transparent',
              color: isActive ? '#6f5532' : '#7d7467',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {panel.label}
          </button>
        );
      })}
    </div>
  );
}
