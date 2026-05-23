import { useLayoutEffect, useRef, useState } from 'react';
import { useUiStore } from '../../store/ui-store';

// 三个带标签的 tab 排成一行所需的最小宽度（含 group padding 4 + 外层 padding 16）。
// 实测 56*3 + 4 + 16 = 188，留一点余量。
const FULL_TABS_MIN_WIDTH = 196;

export function LeftSidebarHeader() {
  const activeLeftPanel = useUiStore((s) => s.activeLeftPanel);
  const setActiveLeftPanel = useUiStore((s) => s.setActiveLeftPanel);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const [compact, setCompact] = useState(false);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => setCompact(el.clientWidth < FULL_TABS_MIN_WIDTH);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={rootRef}
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
          compact={compact}
          isActive={activeLeftPanel === 'nodes'}
          onClick={() => setActiveLeftPanel('nodes')}
        />
        <PanelTab
          label="元素"
          glyph="◆"
          compact={compact}
          isActive={activeLeftPanel === 'elements'}
          onClick={() => setActiveLeftPanel('elements')}
        />
        <PanelTab
          label="浮缀"
          glyph="❦"
          compact={compact}
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
  compact,
  isActive,
  onClick,
}: {
  label: string;
  glyph?: string;
  compact: boolean;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={compact ? label : undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: compact ? 0 : 6,
        background: isActive ? 'hsl(var(--surface))' : 'transparent',
        color: isActive ? 'hsl(var(--ink-1))' : 'hsl(var(--ink-3))',
        padding: compact ? '4px 8px' : '4px 10px',
        fontSize: 11.5,
        cursor: 'pointer',
        fontFamily: 'var(--font-mono)',
        letterSpacing: '0.08em',
        fontWeight: 500,
        border: 'none',
        borderRadius: 3,
        boxShadow: isActive ? '0 1px 2px hsl(var(--ink-1) / 0.06)' : 'none',
        transition: 'background 0.15s, color 0.15s',
        minWidth: compact ? 28 : 56,
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
      {!compact && <span>{label}</span>}
    </button>
  );
}
