import { motion } from 'framer-motion';
import { useUiStore } from '../../store/ui-store';
import { Network, BookOpen, Layers, Home } from 'lucide-react';
import useMeasure from 'react-use-measure';
import { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';

export function LeftSidebarHeader() {
  const { navigateToHome } = useProjectNavigation();
  const activeLeftPanel = useUiStore((s) => s.activeLeftPanel);
  const setActiveLeftPanel = useUiStore((s) => s.setActiveLeftPanel);

  const activeSuperView = useUiStore((s) => s.activeSuperView);
  const setActiveSuperView = useUiStore((s) => s.setActiveSuperView);
  const lastActiveSuperView = useUiStore((s) => s.lastActiveSuperView);

  const [ref, bounds] = useMeasure();

  // Responsive Thresholds
  // Full (~180px+) -> Icon Only (~100px+) -> Merged (<100px)
  const isIconMode = bounds.width < 180 && bounds.width >= 100;
  const isCollapsed = bounds.width < 100;

  // Determine effective active/icon for merged button
  const effectiveView =
    activeSuperView !== 'none' ? activeSuperView : lastActiveSuperView || 'graph';

  // Config for super views
  const views = {
    element: { label: 'Elements', icon: <Layers size={13} />, id: 'element' as const },
    graph: { label: 'Graph', icon: <Network size={13} />, id: 'graph' as const },
    reference: { label: 'Refs', icon: <BookOpen size={13} />, id: 'reference' as const },
  };

  const currentViewConfig = views[effectiveView];

  return (
    <div
      style={{
        display: 'flex',
        height: 40,
        width: '100%',
        borderBottom: '1px solid hsl(var(--rule))',
        alignItems: 'center',
        padding: '0 8px',
        gap: 8,
        overflow: 'hidden',
      }}
    >
      {/* Home Button — left edge */}
      <button
        onClick={() => navigateToHome()}
        title="Project Home"
        style={{
          flexShrink: 0,
          width: 26,
          height: 26,
          borderRadius: 4,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          background: 'transparent',
          color: 'hsl(var(--ink-3))',
          border: 'none',
          padding: 0,
          transition: 'background 0.15s, color 0.15s',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'hsl(var(--paper-deep))';
          e.currentTarget.style.color = 'hsl(var(--ink-1))';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = 'hsl(var(--ink-3))';
        }}
      >
        <Home size={13} strokeWidth={1.6} />
      </button>

      {/* Panel Tabs — Nodes / Elements / Drift segmented switch */}
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
          label="Nodes"
          isActive={activeLeftPanel === 'nodes'}
          onClick={() => setActiveLeftPanel('nodes')}
        />
        <PanelTab
          label="Elements"
          isActive={activeLeftPanel === 'elements'}
          onClick={() => setActiveLeftPanel('elements')}
        />
        <PanelTab
          label="Drift"
          isActive={activeLeftPanel === 'drift'}
          onClick={() => setActiveLeftPanel('drift')}
        />
      </div>

      {/* Super View Toggles — right side */}
      <div ref={ref} style={{ display: 'flex', flex: 1, gap: 2, height: 28, position: 'relative', justifyContent: 'flex-end' }}>
        {!isCollapsed ? (
          <>
            <SuperButton
              label={views.element.label}
              icon={views.element.icon}
              isActive={activeSuperView === 'element'}
              onClick={() => setActiveSuperView(activeSuperView === 'element' ? 'none' : 'element')}
              showLabel={!isIconMode}
            />
            <SuperButton
              label={views.graph.label}
              icon={views.graph.icon}
              isActive={activeSuperView === 'graph'}
              onClick={() => setActiveSuperView(activeSuperView === 'graph' ? 'none' : 'graph')}
              showLabel={!isIconMode}
            />
            <SuperButton
              label={views.reference.label}
              icon={views.reference.icon}
              isActive={activeSuperView === 'reference'}
              onClick={() =>
                setActiveSuperView(activeSuperView === 'reference' ? 'none' : 'reference')
              }
              showLabel={!isIconMode}
            />
          </>
        ) : (
          <MergedSuperButton
            views={Object.values(views)}
            currentView={currentViewConfig}
            activeView={activeSuperView}
            onSelect={(id) => setActiveSuperView(activeSuperView === id ? 'none' : id)}
          />
        )}
      </div>
    </div>
  );
}

function PanelTab({
  label,
  isActive,
  onClick,
}: {
  label: string;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        background: isActive ? 'hsl(var(--surface))' : 'transparent',
        color: isActive ? 'hsl(var(--ink-1))' : 'hsl(var(--ink-3))',
        padding: '4px 12px',
        fontSize: 11.5,
        cursor: 'pointer',
        fontFamily: 'var(--font-mono)',
        textTransform: 'uppercase',
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
      {label}
    </button>
  );
}

function SuperButton({
  label,
  icon,
  isActive,
  onClick,
  showLabel = true,
}: {
  label: string;
  icon: React.ReactNode;
  isActive: boolean;
  onClick: () => void;
  showLabel?: boolean;
}) {
  return (
    <motion.button
      onClick={onClick}
      initial={{ flex: showLabel ? 1 : 0 }}
      animate={{ flex: showLabel ? 1 : 0 }}
      whileHover={{ flex: showLabel ? 2.2 : 0 }}
      style={{
        background: isActive ? 'hsl(var(--accent) / 0.10)' : 'transparent',
        color: isActive ? 'hsl(var(--accent))' : 'hsl(var(--ink-3))',
        borderRadius: 4,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        overflow: 'hidden',
        position: 'relative',
        border: 'none',
        boxShadow: isActive ? 'inset 0 0 0 1px hsl(var(--accent) / 0.30)' : 'none',
        boxSizing: 'border-box',
        minWidth: 28,
        height: 26,
        width: showLabel ? 'auto' : 28,
        padding: showLabel ? '0 8px' : 0,
        transition: 'background 0.15s, color 0.15s',
      }}
      onMouseEnter={(e) => {
        if (!isActive) {
          e.currentTarget.style.background = 'hsl(var(--paper-deep))';
          e.currentTarget.style.color = 'hsl(var(--ink-1))';
        }
      }}
      onMouseLeave={(e) => {
        if (!isActive) {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = 'hsl(var(--ink-3))';
        }
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          whiteSpace: 'nowrap',
          gap: 6,
        }}
      >
        {icon}
        {showLabel && (
          <motion.span
            style={{
              fontSize: 10,
              fontFamily: 'var(--font-mono)',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              fontWeight: 500,
            }}
            initial={{ opacity: 0, width: 0 }}
            whileHover={{ opacity: 1, width: 'auto' }}
          >
            {label}
          </motion.span>
        )}
      </div>
    </motion.button>
  );
}

function MergedSuperButton({
  views,
  currentView,
  activeView,
  onSelect,
}: {
  views: { label: string; icon: React.ReactNode; id: 'element' | 'graph' | 'reference' }[];
  currentView: { label: string; icon: React.ReactNode; id: 'element' | 'graph' | 'reference' };
  activeView: string;
  onSelect: (id: 'element' | 'graph' | 'reference') => void;
}) {
  const [isHovering, setIsHovering] = useState(false);
  const buttonRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(
    null,
  );

  const handleMouseEnter = () => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setPosition({
        top: rect.bottom,
        left: rect.left,
        width: rect.width,
      });
      setIsHovering(true);
    }
  };

  const isActive = activeView !== 'none';

  return (
    <div
      ref={buttonRef}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={() => setIsHovering(false)}
      style={{
        position: 'relative',
        width: 28,
        height: '100%',
        display: 'flex',
        justifyContent: 'flex-end',
      }}
    >
      <motion.div
        onClick={() => onSelect(currentView.id)}
        style={{
          background: isActive ? 'hsl(var(--accent) / 0.10)' : 'transparent',
          color: isActive ? 'hsl(var(--accent))' : 'hsl(var(--ink-3))',
          borderRadius: 4,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          width: '100%',
          height: 26,
          boxShadow: isActive ? 'inset 0 0 0 1px hsl(var(--accent) / 0.30)' : 'none',
          zIndex: isHovering ? 200 : 100,
        }}
      >
        {currentView.icon}
      </motion.div>

      {isHovering &&
        position &&
        createPortal(
          <div
            style={{
              position: 'fixed',
              top: position.top,
              left: position.left,
              width: position.width,
              zIndex: 9999,
              paddingTop: 4,
            }}
            onMouseEnter={() => setIsHovering(true)}
            onMouseLeave={() => setIsHovering(false)}
          >
            <div
              style={{
                background: 'hsl(var(--surface))',
                borderRadius: 6,
                boxShadow: '0 8px 24px hsl(var(--ink-1) / 0.12), 0 1px 2px hsl(var(--ink-1) / 0.06)',
                border: '1px solid hsl(var(--rule))',
                padding: 4,
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
              }}
            >
              {views.map((view) => {
                const viewActive = activeView === view.id;
                return (
                  <div
                    key={view.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(view.id);
                      setIsHovering(false);
                    }}
                    style={{
                      height: 26,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 3,
                      cursor: 'pointer',
                      background: viewActive ? 'hsl(var(--accent) / 0.10)' : 'transparent',
                      color: viewActive ? 'hsl(var(--accent))' : 'hsl(var(--ink-2))',
                      transition: 'background 0.15s',
                    }}
                    onMouseEnter={(e) => {
                      if (!viewActive) e.currentTarget.style.background = 'hsl(var(--paper-deep))';
                    }}
                    onMouseLeave={(e) => {
                      if (!viewActive) e.currentTarget.style.background = 'transparent';
                    }}
                    title={view.label}
                  >
                    {view.icon}
                  </div>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
