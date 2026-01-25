import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, Outlet, useLocation, useParams } from 'react-router-dom';
import { NodeEditorView } from './views/NodeEditorView';
import { ElementEditorView } from './views/ElementEditorView';
import { CategoryEditorView } from './views/CategoryEditorView';
import { StorylineEditorView } from './views/StorylineEditorView';
import { GraphView } from './views/GraphView';
import { LoginPage } from './views/LoginPage';
import { RegisterPage } from './views/RegisterPage';
import { initDatabase } from './lib/db';
import { events } from './lib/events';
import { ElementPanel } from './viewComponents/leftBars/ElementPanel';
import { LeftSidebarHeader } from './viewComponents/leftBars/LeftSidebarHeader';
import { NodesPanel } from './viewComponents/leftBars/NodesPanel';
import { SuperElementView, SuperReferenceView } from './views/SuperViews/SuperViews';
import { Sidebar } from './viewComponents/Sidebar';
import { BottomTimeline } from './viewComponents/BottomTimeline/BottomTimeline';
import { SettingsModal } from './viewComponents/modals/SettingsModal';
import { initAccentColor } from './lib/theme';
import { useUiStore } from './store/ui-store';
import { useAuthStore } from './store/auth';
import { useBookNode } from './usecase/useBookNode';
import { useStoryline } from './usecase/useStoryline';
import { useBookElement } from './usecase/useBookElement';
import { useElementCategory } from './usecase/useElementCategory';
import { AppTopbar } from './views/AppTopbar';
import loglevel from "loglevel";

const log = loglevel.getLogger("App");
// log.setLevel(loglevel.levels.ERROR);
log.setLevel(loglevel.levels.TRACE);

// 认证路由守卫
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const [isChecking, setIsChecking] = useState(true);
  const checkSession = useAuthStore((state) => state.checkSession);

  useEffect(() => {
    checkSession().finally(() => setIsChecking(false));
  }, [checkSession]);

  if (isChecking) {
    return (
      <div style={{ height: '100vh', width: '100vw', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        Checking authentication...
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

function Layout() {
  const location = useLocation();
  const { projectId } = useParams<{ projectId: string }>();
  const isEditorRoute = location.pathname.includes('/editor');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [dbReady, setDbReady] = useState(false);
  const userId = useAuthStore((state) => state.user?.id);
  const nodeUsecases = useBookNode({ projectId: projectId ?? '', userId: userId ?? '' });
  const storylineUsecases = useStoryline({ projectId: projectId ?? '', userId: userId ?? '' });
  const elementUsecases = useBookElement({ projectId: projectId ?? '', userId: userId ?? '' });
  const categoryUsecases = useElementCategory({ projectId: projectId ?? '', userId: userId ?? '' });

  useEffect(() => {
    // Initialize theme
    initAccentColor();

    // Initialize database for the current user
    if (!projectId) {
      log.error('No projectId found in URL params');
      return;
    }
    if (!userId) {
      log.error('No userId found in auth store');
      return;
    }

    // Reset ready state on project switch
    setDbReady(false);

    log.info('[App] Initializing database for user:', userId);

    initDatabase(userId).then(async () => {
      // Initialize project-specific data (stores etc)
      await Promise.all([
        nodeUsecases.loadNodes(),
        storylineUsecases.loadStorylines(),
        elementUsecases.loadInitial(),
        categoryUsecases.loadCategories(),
      ]);

      events.emit('db:ready');
      log.info('[App] Database ready for project:', projectId);
      setDbReady(true);
    }).catch(error => {
      log.error('[App] Failed to initialize database:', error);
      events.emit('db:error', { error: error.message });
    });
  }, [projectId, userId, nodeUsecases, storylineUsecases, elementUsecases, categoryUsecases]); // Re-init when projectId or user changes

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
  const activeSuperView = useUiStore((state) => state.activeSuperView);
  const setActiveSuperView = useUiStore((state) => state.setActiveSuperView);
  const activeLeftPanel = useUiStore((state) => state.activeLeftPanel);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd + Shift + \ (Backslash)
      if (e.metaKey && e.shiftKey && e.code === 'Backslash') {
        e.preventDefault();
        if (activeSuperView === 'graph') {
          setActiveSuperView('none');
        } else {
          setActiveSuperView('graph');
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeSuperView, setActiveSuperView]);

  if (!dbReady) {
    return (
      <div style={{ height: '100vh', width: '100vw', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        Loading Project...
      </div>
    );
  }

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
            <LeftSidebarHeader />
          </div>
          <div
            style={{
              flex: 1,
              minHeight: 0, // 关键：防止 flex 子元素溢出
              borderTop: '1px solid rgba(145, 145, 145, 0.25)',
              position: 'relative',
            }}
          >
            {activeLeftPanel === 'elements' ? <ElementPanel /> : <NodesPanel />}
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
      {activeSuperView === 'graph' && <GraphView />}
      {activeSuperView === 'element' && <SuperElementView />}
      {activeSuperView === 'reference' && <SuperReferenceView />}
      <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
    </div>
  );
}

import { ProjectHomeView } from './views/ProjectHomeView';

export default function App() {
  return (
    <Routes>
      {/* 公开路由 */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />

      {/* 受保护的路由 */}
      <Route path="/" element={
        <ProtectedRoute>
          <ProjectHomeView />
        </ProtectedRoute>
      } />

      {/* Project-scoped routes */}
      <Route path="/project/:projectId" element={
        <ProtectedRoute>
          <Layout />
        </ProtectedRoute>
      }>
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
