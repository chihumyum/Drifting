import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, Outlet, useLocation } from 'react-router-dom';
import { NodeEditorView } from './views/NodeEditorView';
import { ElementEditorView } from './views/ElementEditorView';
import { CategoryEditorView } from './views/CategoryEditorView';
import { StorylineEditorView } from './views/StorylineEditorView';
import { GraphView } from './views/GraphView';
import { initDatabase } from './lib/db';
import { events } from './lib/events';
import { ElementPanel } from './viewComponents/leftBars/ElementPanel';
import log from "loglevel";

log.setLevel(log.levels.ERROR);
import { LeftQuickButtons } from './viewComponents/leftBars/LeftQuickButtons';
import { LeftSidebar } from './viewComponents/leftBars/LeftSidebar';
import { BottomTimeline } from './viewComponents/BottomTimeline';
import { DEFAULT_PROJECT } from './schema/table';
import { SettingsModal } from './viewComponents/modals/SettingsModal';
import { LeftSidebarTopBar } from './viewComponents/topBars/LeftSidebarTopBar';
import { MainTopBar } from './viewComponents/topBars/MainTopBar';
import { CreateChapterButton } from './viewComponents/topBars/CreateChapterButton';
import { TopTimeline } from './viewComponents/TopTimeline';
import { initAccentColor } from './lib/theme';
import { useAppStore } from './store';


function Layout() {
  const location = useLocation();
  const isEditorRoute = location.pathname.includes('/editor');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isLeftSidebarOpen, setIsLeftSidebarOpen] = useState(true);
  const timelineHeight = useAppStore((state) => state.timelineHeight);

  useEffect(() => {
    // Initialize theme
    initAccentColor();

    // Initialize database in local-only mode (Electron/Obsidian style)
    // Always use anonymous/local database for better offline experience
    const projectId = DEFAULT_PROJECT.id;

    log.info('[App] Initializing local database (offline-first mode)');

    initDatabase(projectId).then(() => {
      events.emit('db:ready');
      log.info('[App] Local database ready');
    }).catch(error => {
      log.error('Failed to initialize database:', error);
      events.emit('db:error', { error: error.message });
    });
  }, []); // No dependencies - init once on mount

  // listen for left topbar events
  useEffect(() => {
    const handleOpenSettings = () => setIsSettingsOpen(true);
    events.on('settings:open', handleOpenSettings);
    const handleOpenSearch = () => setIsSearchOpen(true);
    events.on('search:open', handleOpenSearch);
    const handleToggleLeftSidebar = () => { setIsLeftSidebarOpen(prev => !prev)};
    events.on('left-sidebar:toggle', handleToggleLeftSidebar);
    
    return () => {
      events.off('left-sidebar:toggle', handleToggleLeftSidebar);
      events.off('settings:open', handleOpenSettings);
      events.off('search:open', handleOpenSearch);
    };

  }, []);

  // Global Shortcut for Graph View (Cmd + Shift + \)
  const isGraphViewOpen = useAppStore((state) => state.isGraphViewOpen);
  const setGraphViewOpen = useAppStore((state) => state.setGraphViewOpen);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd + Shift + \ (Backslash)
      if (e.metaKey && e.shiftKey && e.code === 'Backslash') {
        e.preventDefault();
        setGraphViewOpen(!isGraphViewOpen);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isGraphViewOpen, setGraphViewOpen]);

  return (
    <div style={{ height: '100vh', overflow: 'hidden', background: 'rgba(251, 249, 243, 1)' }}>
      <div
        style={{
          height: `calc(100vh - ${timelineHeight}px)`,
          display: 'grid',
          gridTemplateColumns: '280px 1fr',
          overflow: 'hidden',
        }}
      >        {/* Left Sidebar - 使用抽象的 LeftSidebar 组件 */}
        <LeftSidebar
          topBar={<LeftSidebarTopBar />}
          collapsible={true}
        >
          {/* 可插拔的内容区域 */}
          {/* App Menu Section */}
          <div style={{ flexShrink: 0 }}>
            <LeftQuickButtons />
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
        </LeftSidebar>

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
          <MainTopBar rightContent={<CreateChapterButton />}>
            <TopTimeline />
          </MainTopBar>

          {/* 内容区域 */}
          <div style={{
            flex: 1,
            position: 'relative',
            overflow: 'hidden',
          }}>
            <Outlet />
          </div>
        </main>
      </div>

      {/* Timeline Chapters - Fixed at bottom, full width */}
      <BottomTimeline />

      {/* Graph View Overlay */}
      {isGraphViewOpen && <GraphView />}

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
