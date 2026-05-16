import { useUiStore } from '../../store/ui-store';

type RightPanelId = 'references' | 'inspirations' | 'ai';

const PANELS: Array<{ id: RightPanelId; label: string }> = [
  { id: 'references', label: '参考' },
  { id: 'inspirations', label: '灵感' },
  { id: 'ai', label: 'AI' },
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
        gap: 0,
        padding: 2,
        background: inline ? 'hsl(var(--paper-deep))' : 'transparent',
        borderRadius: inline ? 4 : 0,
        borderBottom: inline ? 'none' : '1px solid hsl(var(--rule))',
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
              height: inline ? 22 : 26,
              borderRadius: 3,
              border: 'none',
              background: isActive ? 'hsl(var(--surface))' : 'transparent',
              color: isActive ? 'hsl(var(--ink-1))' : 'hsl(var(--ink-3))',
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              fontWeight: 500,
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              boxShadow: isActive ? '0 1px 2px hsl(var(--ink-1) / 0.06)' : 'none',
              transition: 'background 0.15s, color 0.15s',
            }}
            onMouseEnter={(e) => {
              if (!isActive) e.currentTarget.style.color = 'hsl(var(--ink-1))';
            }}
            onMouseLeave={(e) => {
              if (!isActive) e.currentTarget.style.color = 'hsl(var(--ink-3))';
            }}
          >
            {panel.label}
          </button>
        );
      })}
    </div>
  );
}
