import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, Outlet, useLocation } from 'react-router-dom';
import { NodeEditorView } from './views/NodeEditorView';
import { ElementEditorView } from './views/ElementEditorView';
import { CategoryEditorView } from './views/CategoryEditorView';
import { StorylineEditorView } from './views/StorylineEditorView';
import { initDatabase } from './lib/db';
import { events } from './lib/events';
import { ElementPanel } from './components/ElementPanel';
import { AppSidebar } from './components/AppSidebar';
import { TimelineChapters } from './components/TimelineChapters';
import { BackButton } from './components/BackButton';
import { DEFAULT_PROJECT } from './schema/table';
import { SettingsModal } from './components/modals/SettingsModal';
import { SidebarTopBar } from './components/SidebarTopBar';
import { MainTopBar } from './components/MainTopBar';
import { initAccentColor } from './lib/theme';
import { useAppStore } from './store';


function Layout() {
  const location = useLocation();
  const isEditorRoute = location.pathname.includes('/editor');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const timelineHeight = useAppStore((state) => state.timelineHeight);
  
  useEffect(() => {
    // Initialize theme
    initAccentColor();
    
    // Initialize database in local-only mode (Electron/Obsidian style)
    // Always use anonymous/local database for better offline experience
    const projectId = DEFAULT_PROJECT.id;
    
    console.log('[App] Initializing local database (offline-first mode)');
    
    initDatabase(projectId).then(() => {
      events.emit('db:ready');
      console.log('[App] Local database ready');
    }).catch(error => {
      console.error('Failed to initialize database:', error);
      events.emit('db:error', { error: error.message });
    });
  }, []); // No dependencies - init once on mount

  useEffect(() => {
    // Listen for settings open event
    const handleOpenSettings = () => setIsSettingsOpen(true);
    events.on('settings:open', handleOpenSettings);
    return () => {
      events.off('settings:open', handleOpenSettings);
    };
  }, []);

  return (
    <div style={{ height: '100vh', overflow: 'hidden', background: 'rgba(251, 249, 243, 1)' }}>
      <div
        style={{
          height: `calc(100vh - ${timelineHeight}px)`,
          display: 'grid',
          gridTemplateColumns: '280px 1fr',
          overflow: 'hidden',
        }}
      >
        {/* Left Sidebar - Combined App Menu + Element Panel */}
        <div
          className="bg-paper-light border-r border-accent-border-light"
          style={{
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            borderRight: '1px solid rgba(213, 213, 213, 0.3)',
            position: 'relative',
            overflow: 'visible',
          }}
        >
          {/* 侧栏 TopBar - 第一段 */}
          <SidebarTopBar />
          
          {/* App Menu Section */}
          <div style={{ flexShrink: 0 }}>
            <AppSidebar />
          </div>

          {/* Element Panel Section - Remaining space */}
          <div style={{ 
            flex: 1,
            minHeight: 0,
            borderTop: '1px solid rgba(145, 145, 145, 0.25)',
            position: 'relative',
            overflow: 'visible',
          }}>
            <ElementPanel />
          </div>
        </div>

        {/* Main Content Area */}
        <main
          style={{
            position: 'relative',
            overflow: 'hidden',
            background: isEditorRoute ? 'rgba(251, 249, 243, 1)' : 'transparent',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* 主区域 TopBar - 第二段（可拖拽） */}
          <MainTopBar>
            {/* 这里可以放面包屑或标题 */}
          </MainTopBar>
          
          {/* 内容区域 */}
          <div style={{
            flex: 1,
            position: 'relative',
            overflow: 'hidden',
          }}>
            <BackButton />
            <Outlet />
          </div>
        </main>
      </div>

      {/* Timeline Chapters - Fixed at bottom, full width */}
      <TimelineChapters />

      {/* Settings Modal */}
      <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
      {/* SyncStatusHUD disabled in local-only mode */}
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      {/* Main App - Direct access, no authentication required (local-first) */}
      <Route path="/" element={<Layout />}>
        <Route path="editor" element={<Navigate to="/" replace />} />
        <Route path="editor/:nodeId" element={<NodeEditorView />} />
        <Route path="editor/storyline/:storylineId" element={<StorylineEditorView />} />
        <Route path="element/:elementId" element={<ElementEditorView />} />
        <Route path="category/:categoryName" element={<CategoryEditorView />} />
      </Route>
    </Routes>
  );
}
