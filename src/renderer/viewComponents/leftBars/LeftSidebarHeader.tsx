import { motion } from 'framer-motion';
import { useUiStore } from '../../store/ui-store';
import { Network, BookOpen, Layers } from 'lucide-react';
import useMeasure from 'react-use-measure';
import { useState, useRef } from 'react';
import { createPortal } from 'react-dom';

export function LeftSidebarHeader() {
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

    // Determine effective active/icon for merged button
    const effectiveView = activeSuperView !== 'none' ? activeSuperView : (lastActiveSuperView || 'graph');

    // Config for views
    const views = {
        element: { label: 'Sup', icon: <Layers size={14} />, id: 'element' as const },
        graph: { label: 'Active Super', icon: <Network size={14} />, id: 'graph' as const },
        reference: { label: 'Sup', icon: <BookOpen size={14} />, id: 'reference' as const }
    };

    const currentViewConfig = views[effectiveView];

    return (
        <div style={{
            display: 'flex',
            height: 40,
            width: '100%',
            // background: 'lightblue', // Debug color
            borderBottom: '1px solid rgba(213, 213, 213, 0.3)',
            alignItems: 'center',
            padding: '0 4px',
            gap: 4,
            overflow: 'hidden'
        }}>
            {/* Panel Tabs (Left Side) - Fixed width or flex? Sketch shows about 40% width */}
            <div style={{ display: 'flex', flexShrink: 0, gap: 0, border: '1px solid #333', borderRadius: 4, overflow: 'hidden' }}>
                <PanelTab
                    label="Nodes"
                    isActive={activeLeftPanel === 'nodes'}
                    onClick={() => setActiveLeftPanel('nodes')}
                />
                <div style={{ width: 1, background: '#333' }} />
                <PanelTab
                    label="Elements"
                    isActive={activeLeftPanel === 'elements'}
                    onClick={() => setActiveLeftPanel('elements')}
                />
            </div>

            {/* Super Buttons (Right Side) - Occupy remaining space */}
            <div ref={ref} style={{ display: 'flex', flex: 1, gap: 4, height: 28, position: 'relative' }}>
                {!isCollapsed ? (
                    <>
                        <SuperButton
                            label="Sup"
                            icon={<Layers size={14} />}
                            isActive={activeSuperView === 'element'}
                            onClick={() => setActiveSuperView(activeSuperView === 'element' ? 'none' : 'element')}
                            showLabel={!isIconMode}
                        />
                        <SuperButton
                            label="Active Super"
                            icon={<Network size={14} />}
                            isActive={activeSuperView === 'graph'}
                            onClick={() => setActiveSuperView(activeSuperView === 'graph' ? 'none' : 'graph')}
                            showLabel={!isIconMode}
                        />
                        <SuperButton
                            label="Sup"
                            icon={<BookOpen size={14} />}
                            isActive={activeSuperView === 'reference'}
                            onClick={() => setActiveSuperView(activeSuperView === 'reference' ? 'none' : 'reference')}
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

function PanelTab({ label, isActive, onClick }: { label: string, isActive: boolean, onClick: () => void }) {
    return (
        <div
            onClick={onClick}
            style={{
                background: isActive ? '#f06060' : '#e0e0e0',
                color: isActive ? 'white' : 'black',
                padding: '4px 8px',
                fontSize: 12,
                cursor: 'pointer',
                fontWeight: 500,
                transition: 'background 0.2s',
                minWidth: 50,
                textAlign: 'center'
            }}
        >
            {label}
        </div>
    )
}

function SuperButton({ label, icon, isActive, onClick, showLabel = true }: { label: string, icon: React.ReactNode, isActive: boolean, onClick: () => void, showLabel?: boolean }) {
    return (
        <motion.div
            onClick={onClick}
            initial={{ flex: 1 }}
            animate={{ flex: showLabel ? 1 : 0 }}
            whileHover={{ flex: showLabel ? 3 : 0 }} // Don't expand flex in icon mode
            style={{
                background: isActive ? '#ffcc00' : '#f5d76e',
                borderRadius: 14, // Pill shape
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                overflow: 'hidden',
                position: 'relative',
                border: isActive ? '2px solid #333' : '1px solid transparent',
                boxSizing: 'border-box',
                minWidth: 28, // Ensure circle possibility
                width: showLabel ? 'auto' : 28 // Force width in icon mode
            }}
        >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', whiteSpace: 'nowrap' }}>
                {icon}
                {showLabel && (
                    <motion.span
                        style={{ marginLeft: 4, fontSize: 11, fontWeight: 600 }}
                        initial={{ opacity: 0, width: 0 }}
                        whileHover={{ opacity: 1, width: 'auto' }}
                    >
                        {label}
                    </motion.span>
                )}
            </div>
        </motion.div>
    )
}

function MergedSuperButton({
    views,
    currentView,
    activeView,
    onSelect
}: {
    views: { label: string, icon: React.ReactNode, id: 'element' | 'graph' | 'reference' }[],
    currentView: { label: string, icon: React.ReactNode, id: 'element' | 'graph' | 'reference' },
    activeView: string,
    onSelect: (id: 'element' | 'graph' | 'reference') => void
}) {
    const [isHovering, setIsHovering] = useState(false);
    const buttonRef = useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState<{ top: number, left: number, width: number } | null>(null);

    const handleMouseEnter = () => {
        if (buttonRef.current) {
            const rect = buttonRef.current.getBoundingClientRect();
            setPosition({
                top: rect.bottom,
                left: rect.left,
                width: rect.width
            });
            setIsHovering(true);
        }
    };

    return (
        <div
            ref={buttonRef}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={() => setIsHovering(false)}
            style={{
                position: 'relative',
                width: '100%',
                height: '100%',
                display: 'flex',
                justifyContent: 'flex-end'
            }}
        >
            {/* The Stack Trigger (Single Button) */}
            <motion.div
                onClick={() => onSelect(currentView.id)}
                style={{
                    background: activeView !== 'none' ? '#ffcc00' : '#f5d76e',
                    borderRadius: 14,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    width: '100%',
                    height: '100%',
                    border: activeView !== 'none' ? '2px solid #333' : '1px solid transparent',
                    boxSizing: 'border-box',
                    zIndex: isHovering ? 200 : 100
                }}
            >
                {currentView.icon}
            </motion.div>

            {/* Global Portal Dropdown */}
            {isHovering && position && createPortal(
                <div
                    style={{
                        position: 'fixed', // Use fixed to ignore scroll parents issues
                        top: position.top,
                        left: position.left,
                        width: position.width,
                        zIndex: 9999,
                        paddingTop: 4, // Space between trigger and menu
                    }}
                    onMouseEnter={() => setIsHovering(true)}
                    onMouseLeave={() => setIsHovering(false)}
                >
                    <div style={{
                        background: '#fff',
                        borderRadius: 14,
                        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                        border: '1px solid #eee',
                        padding: 4,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4
                    }}>
                        {views.map((view) => (
                            <div
                                key={view.id}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onSelect(view.id);
                                    setIsHovering(false);
                                }}
                                style={{
                                    height: 28,
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    borderRadius: 10,
                                    cursor: 'pointer',
                                    background: activeView === view.id ? '#ffcc00' : (currentView.id === view.id ? '#f5f5f5' : '#fff'),
                                    color: '#333',
                                    transition: 'background 0.2s'
                                }}
                                onMouseEnter={(e) => e.currentTarget.style.background = activeView === view.id ? '#ffcc00' : '#f5d76e'}
                                onMouseLeave={(e) => e.currentTarget.style.background = activeView === view.id ? '#ffcc00' : (currentView.id === view.id ? '#f5f5f5' : '#fff')}
                                title={view.label}
                            >
                                {view.icon}
                            </div>
                        ))}
                    </div>
                </div>,
                document.body
            )}
        </div>
    )
}

