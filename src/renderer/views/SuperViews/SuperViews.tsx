import { useUiStore } from '../../store/ui-store';
import { X } from 'lucide-react';

function SuperOverlay({ title, children, onClose }: { title: string, children?: React.ReactNode, onClose: () => void }) {
    return (
        <div style={{
            position: 'absolute',
            top: 42, bottom: 0, left: 0, right: 0,
            background: 'rgba(255, 255, 255, 0.95)',
            zIndex: 50,
            display: 'flex',
            flexDirection: 'column',
            backdropFilter: 'blur(5px)'
        }}>
            <div style={{ height: 40, borderBottom: '1px solid #eee', display: 'flex', alignItems: 'center', padding: '0 16px', justifyContent: 'space-between' }}>
                <span style={{ fontWeight: 600 }}>{title}</span>
                <button onClick={onClose} style={{ border: 'none', background: 'transparent', cursor: 'pointer' }}>
                    <X size={20} />
                </button>
            </div>
            <div style={{ flex: 1, padding: 20 }}>
                {children}
            </div>
        </div>
    )
}

export function SuperElementView() {
    const setActiveSuperView = useUiStore(s => s.setActiveSuperView);
    return (
        <SuperOverlay title="Super Element View" onClose={() => setActiveSuperView('none')}>
            <div style={{ fontSize: 24, textAlign: 'center', marginTop: 100 }}>
                High-level view of all Elements
            </div>
        </SuperOverlay>
    )
}

export function SuperReferenceView() {
    const setActiveSuperView = useUiStore(s => s.setActiveSuperView);
    return (
        <SuperOverlay title="Reference View" onClose={() => setActiveSuperView('none')}>
            <div style={{ fontSize: 24, textAlign: 'center', marginTop: 100 }}>
                Global Reference & Snippets
            </div>
        </SuperOverlay>
    )
}
