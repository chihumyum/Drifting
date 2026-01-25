import { motion } from 'framer-motion';
import { useUiStore } from '../../store/ui-store';
import { Network, BookOpen, Layers } from 'lucide-react';

export function LeftSidebarHeader() {
    const activeLeftPanel = useUiStore((s) => s.activeLeftPanel);
    const setActiveLeftPanel = useUiStore((s) => s.setActiveLeftPanel);

    const activeSuperView = useUiStore((s) => s.activeSuperView);
    const setActiveSuperView = useUiStore((s) => s.setActiveSuperView);

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
            <div style={{ display: 'flex', flex: 1, gap: 4, height: 28 }}>
                <SuperButton
                    label="Sup"
                    icon={<Layers size={14} />}
                    isActive={activeSuperView === 'element'}
                    onClick={() => setActiveSuperView(activeSuperView === 'element' ? 'none' : 'element')}
                />
                <SuperButton
                    label="Active Super"
                    icon={<Network size={14} />}
                    isActive={activeSuperView === 'graph'}
                    onClick={() => setActiveSuperView(activeSuperView === 'graph' ? 'none' : 'graph')}
                />
                <SuperButton
                    label="Sup"
                    icon={<BookOpen size={14} />}
                    isActive={activeSuperView === 'reference'}
                    onClick={() => setActiveSuperView(activeSuperView === 'reference' ? 'none' : 'reference')}
                />
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

function SuperButton({ label, icon, isActive, onClick }: { label: string, icon: React.ReactNode, isActive: boolean, onClick: () => void }) {
    return (
        <motion.div
            onClick={onClick}
            initial={{ flex: 1 }}
            whileHover={{ flex: 3 }}
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
                boxSizing: 'border-box'
            }}
        >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', whiteSpace: 'nowrap' }}>
                {/* Icon is always visible? No, text expands. */}
                {icon}
                <motion.span
                    style={{ marginLeft: 4, fontSize: 11, fontWeight: 600 }}
                    initial={{ opacity: 0, width: 0 }}
                    whileHover={{ opacity: 1, width: 'auto' }}
                >
                    {label}
                </motion.span>
            </div>
        </motion.div>
    )
}
