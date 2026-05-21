import { useUiStore } from '../../store/ui-store';

export function LeftSidebarHeader() {
  const activeLeftPanel = useUiStore((s) => s.activeLeftPanel);
  const setActiveLeftPanel = useUiStore((s) => s.setActiveLeftPanel);

  return (
    <div
      style={{
        display: 'flex',
        height: 40,
        width: '100%',
        borderBottom: '1px solid hsl(var(--rule))',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 8px',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexShrink: 0,
          gap: 0,
          background: 'hsl(var(--paper-deep))',
          borderRadius: 4,
          padding: 2,
        }}
      >
        <PanelTab
          label="章节"
          glyph="§"
          isActive={activeLeftPanel === 'nodes'}
          onClick={() => setActiveLeftPanel('nodes')}
        />
        <PanelTab
          label="元素"
          glyph="◆"
          isActive={activeLeftPanel === 'elements'}
          onClick={() => setActiveLeftPanel('elements')}
        />
        <PanelTab
          label="浮缀"
          glyph="❦"
          isActive={activeLeftPanel === 'drift'}
          onClick={() => setActiveLeftPanel('drift')}
        />
      </div>
    </div>
  );
}

function PanelTab({
  label,
  glyph,
  isActive,
  onClick,
}: {
  label: string;
  glyph?: string;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        background: isActive ? 'hsl(var(--surface))' : 'transparent',
        color: isActive ? 'hsl(var(--ink-1))' : 'hsl(var(--ink-3))',
        padding: '4px 10px',
        fontSize: 11.5,
        cursor: 'pointer',
        fontFamily: 'var(--font-mono)',
        letterSpacing: '0.08em',
        fontWeight: 500,
        border: 'none',
        borderRadius: 3,
        boxShadow: isActive ? '0 1px 2px hsl(var(--ink-1) / 0.06)' : 'none',
        transition: 'background 0.15s, color 0.15s',
        minWidth: 56,
        textAlign: 'center',
      }}
      onMouseEnter={(e) => {
        if (!isActive) e.currentTarget.style.color = 'hsl(var(--ink-1))';
      }}
      onMouseLeave={(e) => {
        if (!isActive) e.currentTarget.style.color = 'hsl(var(--ink-3))';
      }}
    >
      {glyph && (
        <span
          aria-hidden
          style={{
            fontFamily: 'var(--font-serif)',
            fontStyle: 'italic',
            fontSize: 12.5,
            color: isActive ? 'hsl(var(--accent))' : 'hsl(var(--ink-4))',
            lineHeight: 1,
          }}
        >
          {glyph}
        </span>
      )}
      <span>{label}</span>
    </button>
  );
}
