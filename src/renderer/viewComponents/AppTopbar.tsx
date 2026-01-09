import { useUiStore } from '../store/ui-store';
import { LeftSidebarTopBar } from './topBars/LeftSidebarTopBar';
import { MainTopBar } from './topBars/MainTopBar';
import { NewEntityButton } from './topBars/NewEntityButton';
import { TopTimeline } from './TopTimeline';

export function AppTopbar() {
    const leftState = useUiStore(s => s.sidebars.left);
    const rightState = useUiStore(s => s.sidebars.right);
    
    // Calculate widths
    // Traffic lights usually take ~70-80px. LeftSidebarTopBar has paddingLeft: 90.
    // Plus button width ~30px + paddingRight 16px.
    // 90 + 28 + 16 ~= 134px. Let's say 140px safe.
    // Or just let it be auto? No, we want animation.
    const LEFT_COLLAPSED_WIDTH = 140; 
    
    const leftWidth = leftState.isOpen ? leftState.width : LEFT_COLLAPSED_WIDTH;
    const rightWidth = rightState.isOpen ? rightState.width : 0; 
    
    return (
        <div style={{ display: 'flex', width: '100%', height: 42, overflow: 'hidden' }}>
            {/* Left Section */}
            <div style={{ 
                width: leftWidth, 
                transition: 'width 0.2s', 
                borderRight: '1px solid rgba(213, 213, 213, 0.3)',
                flexShrink: 0,
                overflow: 'hidden'
            }}>
                <LeftSidebarTopBar />
            </div>
            
            {/* Middle Section */}
            <div style={{ flex: 1, minWidth: 0, overflow: 'visible' }}>
                 <MainTopBar rightContent={<NewEntityButton />}>
                    <TopTimeline />
                 </MainTopBar>
            </div>
            
            {/* Right Section */}
            <div style={{ 
                width: rightWidth, 
                transition: 'width 0.2s',
                borderLeft: rightWidth > 0 ? '1px solid rgba(213, 213, 213, 0.3)' : 'none',
                flexShrink: 0
            }}>
                {/* Right Top Bar content if any */}
            </div>
        </div>
    )
}
