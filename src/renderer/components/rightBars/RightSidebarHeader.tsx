import { MoreHorizontal } from 'lucide-react';
import { useUiStore } from '../../store/ui-store';

type RightPanelId = 'fragments' | 'stats' | 'shadow';

interface RightSidebarHeaderProps {
  fragmentCount: number;
  shadowReviewCount: number;
  kicker: string;
  title: string;
  /** Pulsates the fragments-count badge after a shadow → fragment conversion. */
  fragmentCountFlash?: boolean;
  /** Pulsates the Shadow tab when shadow mode first activates. */
  shadowJustAppeared?: boolean;
}

export function RightSidebarHeader({
  fragmentCount,
  shadowReviewCount,
  kicker,
  title,
  fragmentCountFlash,
  shadowJustAppeared,
}: RightSidebarHeaderProps) {
  const activeRightPanel = useUiStore((state) => state.activeRightPanel);
  const setActiveRightPanel = useUiStore((state) => state.setActiveRightPanel);
  const shadowMode = useUiStore((state) => state.shadowMode);

  return (
    <>
      <style>{`
        @keyframes insp-tab-count-pulse {
          0%   { color: hsl(var(--ink-4)); transform: scale(1); }
          30%  { color: hsl(var(--accent)); transform: scale(1.4); }
          100% { color: hsl(var(--ink-4)); transform: scale(1); }
        }
        @keyframes insp-shadow-tab-pulse {
          0%, 100% { background: transparent; box-shadow: 0 0 0 0 hsl(var(--accent) / 0.18); }
          50%      { background: hsl(var(--accent) / 0.10); box-shadow: 0 0 0 4px hsl(var(--accent) / 0.10); }
        }
      `}</style>
      <div
        style={{
          display: 'flex',
          alignItems: 'stretch',
          height: 34,
          padding: '0 6px 0 8px',
          gap: 4,
          borderBottom: '1px solid hsl(var(--rule))',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'stretch', flex: 1, minWidth: 0, gap: 2 }}>
          <RightPanelTab
            id="fragments"
            active={activeRightPanel === 'fragments'}
            onClick={() => setActiveRightPanel('fragments')}
          >
            <span>片段</span>
            <span
              style={
                {
                  color: 'hsl(var(--ink-4))',
                  fontSize: 9.5,
                  animation: fragmentCountFlash ? 'insp-tab-count-pulse 700ms ease' : undefined,
                  display: 'inline-block',
                } as React.CSSProperties
              }
            >
              {fragmentCount}
            </span>
          </RightPanelTab>
          <RightPanelTab
            id="stats"
            active={activeRightPanel === 'stats'}
            onClick={() => setActiveRightPanel('stats')}
          >
            <span>Stats</span>
          </RightPanelTab>
          {shadowMode && (
            <RightPanelTab
              id="shadow"
              accent
              active={activeRightPanel === 'shadow'}
              onClick={() => setActiveRightPanel('shadow')}
              extraStyle={
                shadowJustAppeared
                  ? { animation: 'insp-shadow-tab-pulse 1.4s ease-in-out 3' }
                  : undefined
              }
            >
              <span
                style={{
                  fontFamily: 'var(--font-serif)',
                  fontStyle: 'italic',
                  fontSize: 13,
                }}
              >
                ◐
              </span>
              <span>Shadow</span>
              <span style={{ color: 'hsl(var(--ink-4))', fontSize: 9.5 }}>{shadowReviewCount}</span>
            </RightPanelTab>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
          <button
            title="更多"
            style={
              {
                width: 26,
                height: 26,
                alignSelf: 'center',
                display: 'grid',
                placeItems: 'center',
                borderRadius: 3,
                color: 'hsl(var(--ink-4))',
                cursor: 'pointer',
                background: 'transparent',
                border: 'none',
                padding: 0,
              } as React.CSSProperties
            }
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'hsl(var(--paper-deep))';
              e.currentTarget.style.color = 'hsl(var(--ink-1))';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = 'hsl(var(--ink-4))';
            }}
          >
            <MoreHorizontal size={14} strokeWidth={1.7} />
          </button>
        </div>
      </div>

      <div
        style={{
          padding: '10px 14px 8px',
          borderBottom: '1px solid hsl(var(--rule))',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9.5,
            textTransform: 'uppercase',
            letterSpacing: '0.12em',
            color: 'hsl(var(--ink-4))',
            marginBottom: 3,
          }}
        >
          {kicker}
        </div>
        <div
          style={{
            fontFamily: 'var(--font-serif)',
            fontSize: 16,
            fontWeight: 500,
            color: 'hsl(var(--ink-1))',
            lineHeight: 1.25,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title || '—'}
        </div>
      </div>
    </>
  );
}

function RightPanelTab({
  id: _id,
  active,
  accent,
  onClick,
  extraStyle,
  children,
}: {
  id: RightPanelId;
  active: boolean;
  accent?: boolean;
  onClick: () => void;
  extraStyle?: React.CSSProperties;
  children: React.ReactNode;
}) {
  const baseColor = accent ? 'hsl(var(--accent))' : 'hsl(var(--ink-4))';
  const activeColor = accent ? 'hsl(var(--accent))' : 'hsl(var(--ink-1))';
  const underline = accent ? 'hsl(var(--accent))' : 'hsl(var(--ink-1))';
  return (
    <div
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '0 9px',
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        textTransform: 'uppercase',
        letterSpacing: '0.12em',
        color: active ? activeColor : baseColor,
        cursor: 'pointer',
        position: 'relative',
        whiteSpace: 'nowrap',
        borderBottom: active ? `1.5px solid ${underline}` : '1.5px solid transparent',
        marginBottom: -1,
        ...extraStyle,
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.color = 'hsl(var(--ink-2))';
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.color = baseColor;
      }}
    >
      {children}
    </div>
  );
}
