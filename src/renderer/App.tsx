import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, Outlet, useLocation, useParams } from 'react-router-dom';
import { NodeEditorView } from './views/NodeEditorView';
import { ElementEditorView } from './views/ElementEditorView';
import { CategoryEditorView } from './views/CategoryEditorView';
import { StorylineEditorView } from './views/StorylineEditorView';
import { GraphView } from './views/GraphView';
import { initDatabase } from './lib/db';
import { events } from './lib/events';
import { ElementPanel } from './viewComponents/leftBars/ElementPanel';
import { LeftQuickButtons } from './viewComponents/leftBars/LeftQuickButtons';
import { Sidebar } from './viewComponents/Sidebar';
import { BottomTimeline } from './viewComponents/BottomTimeline/BottomTimeline';
import { DEFAULT_PROJECT } from './schema/table';
import { SettingsModal } from './viewComponents/modals/SettingsModal';
import { initAccentColor } from './lib/theme';
import { useUiStore } from './store/ui-store';
import { useProject } from './usecase/useProject';
import { AppTopbar } from './views/AppTopbar';
import loglevel from "loglevel";

const log = loglevel.getLogger("App");
log.setLevel(loglevel.levels.ERROR);

function Layout() {
  const location = useLocation();
  const { projectId } = useParams<{ projectId: string }>();
  const isEditorRoute = location.pathname.includes('/editor');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const { initializeProject } = useProject();

  useEffect(() => {
    // Initialize theme
    initAccentColor();

    // Initialize database for the current project
    // Use projectId from URL params
    if (!projectId) {
      log.error('No projectId found in URL params');
      return;
    }

    log.info('[App] Initializing database for project:', projectId);

    initDatabase(projectId).then(async () => {
      events.emit('db:ready');
      log.info('[App] Database ready for project:', projectId);
      await initializeProject(projectId);
    }).catch(error => {
      log.error('Failed to initialize database:', error);
      events.emit('db:error', { error: error.message });
    });
  }, [projectId]); // Re-init when projectId changes

  // listen for left topbar events
  useEffect(() => {
    const handleOpenSettings = () => setIsSettingsOpen(true);
    events.on('settings:open', handleOpenSettings);
    const handleOpenSearch = () => setIsSearchOpen(true);
    events.on('search:open', handleOpenSearch);
    
    return () => {
      events.off('settings:open', handleOpenSettings);
      events.off('search:open', handleOpenSearch);
    };

  }, []);

  // Global Shortcut for Graph View (Cmd + Shift + \)
  const isGraphViewOpen = useUiStore((state) => state.isGraphViewOpen);
  const setGraphViewOpen = useUiStore((state) => state.setGraphViewOpen);

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
    // 1. 最外层容器：占满屏幕，垂直排列 (中间内容 + 底部时间轴)
    <div
      style={{
        height: '100vh',
        width: '100vw',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* 2. 中间主要区域：水平排列 (侧边栏 + 主内容) */}
      <AppTopbar />
      {/* flex: 1 让它占据除底部时间轴外的所有垂直空间 */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        
        {/* Left Sidebar */}
        {/* 侧边栏不需要设高度，因为它在 flex 容器里会自动撑满高度 */}
        <Sidebar sidebarType="left" >
          <div style={{ flexShrink: 0 }}>
            <LeftQuickButtons />
          </div>
          <div
            style={{
              flex: 1,
              minHeight: 0, // 关键：防止 flex 子元素溢出
              borderTop: '1px solid rgba(145, 145, 145, 0.25)',
              position: 'relative',
            }}
          >
            <ElementPanel />
          </div>
        </Sidebar>

        {/* Main Content Area */}
        {/* flex: 1 让它自动填满侧边栏右侧的剩余宽度 */}
        <main
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            position: 'relative',
            minWidth: 0, // 关键：防止 flex 子元素被宽内容撑爆
            background: isEditorRoute ? 'rgba(251, 249, 243, 1)' : 'transparent',
          }}
        >
          
          {/* Debug Location */}
          <div style={{ flexShrink: 0 }}>{location.pathname}</div>

          {/* Scrollable Content */}
          {/* flex: 1 这里的 overflow: auto 才是真正的滚动区域 */}
          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              overflowX: 'hidden',
              position: 'relative',
            }}
          >
            <Outlet />
          </div>
        </main>
        <Sidebar sidebarType="right" >
          {/* Right Sidebar Content */}
        </Sidebar>
        
      </div>

      {/* 3. 底部时间轴：固定在底部，自然高度 */}
      {/* 不使用 position: fixed，而是作为 flex 的最后一个子元素 */}
      <div style={{ flexShrink: 0, zIndex: 10 }}>
        <BottomTimeline />
      </div>

      {/* Overlays / Modals (绝对定位层) */}
      {isGraphViewOpen && <GraphView />}
      <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      {/* Root redirect to default project */}
      <Route path="/" element={<Navigate to={`/project/${DEFAULT_PROJECT.id}`} replace />} />
      
      {/* Project-scoped routes */}
      <Route path="/project/:projectId" element={<Layout />}>
        <Route index element={<Navigate to="home" replace />} />
        <Route path="home" element={<div>Project Home</div>} />
        <Route path="editor" element={<Navigate to="../home" replace />} />
        <Route path="editor/:nodeId" element={<NodeEditorView />} />
        <Route path="editor/storyline/:storylineId" element={<StorylineEditorView />} />
        <Route path="element/:elementId" element={<ElementEditorView />} />
        <Route path="category/:categoryId" element={<CategoryEditorView />} />
      </Route>
    </Routes>
  );
}
