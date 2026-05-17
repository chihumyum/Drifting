import { useEffect, useState } from 'react';
import {
  Navigate,
  Route,
  Routes,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom';
import { NodeEditorView } from './views/NodeEditorView';
import { ElementEditorView } from './views/ElementEditorView';
import { CategoryEditorView } from './views/CategoryEditorView';
import { StorylineEditorView } from './views/StorylineEditorView';
import { GraphView } from './views/GraphView';
import { LoginPage } from './views/LoginPage';
import { RegisterPage } from './views/RegisterPage';
import { initDatabase } from './lib/db';
import { events } from './lib/events';
import { ElementPanel } from './components/leftBars/ElementPanel';
import { LeftSidebarHeader } from './components/leftBars/LeftSidebarHeader';
import { LeftSidebarSubHeader } from './components/leftBars/LeftSidebarSubHeader';
import { NodesPanel } from './components/leftBars/NodesPanel';
import { DriftPanel } from './components/leftBars/DriftPanel';
import { RightSidebarPanels } from './components/rightBars/RightSidebarPanels';
import { SuperElementView, SuperReferenceView } from './views/SuperViews/SuperViews';
import { Sidebar } from './components/Sidebar';
import { BottomTimeline } from './components/BottomTimeline/BottomTimeline';
import { SettingsModal } from './components/modals/SettingsModal';
import { SyncStatusHUD } from './components/sync/SyncStatusHUD';
import { EditorFindPanel } from './components/search/EditorFindPanel';
import { GlobalSearchModal } from './components/search/GlobalSearchModal';
import { initAccentColor } from './lib/theme';
import { useUiStore, tabKey } from './store/ui-store';
import { useShortcutsStore } from './store/shortcuts-store';
import { matchesAccelerator } from './lib/shortcuts';
import { getActiveEditor, saveActiveEditor, subscribeActiveEditor } from './lib/active-editor';
import type { Editor } from '@tiptap/core';
import { useProjectNavigation } from './hooks/useProjectNavigation';
import { useAuthStore } from './store/auth';
import { useBookNode } from './usecase/useBookNode';
import { useStoryline } from './usecase/useStoryline';
import { useBookElement } from './usecase/useBookElement';
import { useElementCategory } from './usecase/useElementCategory';
import { AppTopbar } from './views/AppTopbar';
import { EditorShell } from './views/EditorShell';
import { ShadowOrb } from './components/ShadowOrb';
import { isAuthRequired } from './lib/config';
import { pullAndHydrateProjectGraph } from './services/entity-sync.service';
import { rebuildProjectInlineReferenceIndex } from './services/reference-index.service';
import loglevel from 'loglevel';

const log = loglevel.getLogger('App');
// log.setLevel(loglevel.levels.ERROR);
log.setLevel(loglevel.levels.TRACE);

// 认证路由守卫
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const authRequired = isAuthRequired();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const userId = useAuthStore((state) => state.user?.id);
  const [isChecking, setIsChecking] = useState(true);
  const checkSession = useAuthStore((state) => state.checkSession);

  useEffect(() => {
    checkSession().finally(() => setIsChecking(false));
  }, [checkSession]);

  if (isChecking) {
    return (
      <div
        style={{
          height: '100vh',
          width: '100vw',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        Checking authentication...
      </div>
    );
  }

  if (authRequired && (!isAuthenticated || !userId)) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

function PublicRoute({ children }: { children: React.ReactNode }) {
  const authRequired = isAuthRequired();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const userId = useAuthStore((state) => state.user?.id);
  const [isChecking, setIsChecking] = useState(true);
  const checkSession = useAuthStore((state) => state.checkSession);

  useEffect(() => {
    checkSession().finally(() => setIsChecking(false));
  }, [checkSession]);

  if (isChecking) {
    return (
      <div
        style={{
          height: '100vh',
          width: '100vw',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        Checking authentication...
      </div>
    );
  }

  if (!authRequired || (isAuthenticated && !!userId)) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}

function Layout() {
  const location = useLocation();
  const { projectId } = useParams<{ projectId: string }>();
  const userId = useAuthStore((state) => state.user?.id);
  if (!projectId) {
    log.error('No projectId found in URL params');
    throw new Error('Project ID is required in URL');
  }
  if (!userId) {
    log.error('No userId found in auth store');
    throw new Error('User must be authenticated');
  }
  const isEditorRoute = location.pathname.includes('/editor');
  const isProjectDashboardHome = Boolean(
    projectId && location.pathname === `/project/${projectId}/home`,
  );
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [dbReady, setDbReady] = useState(false);
  const [findPanelEditor, setFindPanelEditor] = useState<Editor | null>(null);
  const [isGlobalSearchOpen, setIsGlobalSearchOpen] = useState(false);
  const { openEntity, navigateToHome } = useProjectNavigation();
  const navigate = useNavigate();
  const nodeUsecases = useBookNode({ projectId: projectId, userId: userId });
  const storylineUsecases = useStoryline({ projectId: projectId, userId: userId });
  const elementUsecases = useBookElement({ projectId: projectId, userId: userId });
  const categoryUsecases = useElementCategory({ projectId: projectId, userId: userId });

  // Reset ready state when project or user changes
  useEffect(() => {
    setDbReady(false);
  }, [projectId, userId]);

  // Apply theme (light/dark) on every change. The store persists the choice,
  // so initial render of the user menu sees the same value used here.
  const theme = useUiStore((state) => state.theme);
  const shadowMode = useUiStore((state) => state.shadowMode);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [theme]);

  // Shadow mode shifts the full palette via token overrides in index.css.
  // Setting the attribute on <html> means the entire app — editor included
  // — picks up the cool slate tones without per-component conditionals.
  useEffect(() => {
    const root = document.documentElement;
    if (shadowMode) {
      root.setAttribute('data-shadow-mode', 'on');
    } else {
      root.removeAttribute('data-shadow-mode');
    }
  }, [shadowMode]);

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

    log.info('[App] Initializing database for user:', userId);

    initDatabase(userId)
      .then(async () => {
        // Initialize project-specific data (stores etc)
        await Promise.all([
          nodeUsecases.loadNodes(),
          nodeUsecases.loadEdges(),
          storylineUsecases.loadStorylines(),
          elementUsecases.loadInitial(),
          categoryUsecases.loadCategories(),
        ]);
        // Node-storyline mapping depends on nodes being loaded first.
        await storylineUsecases.loadNodeStorylineMapping();
        await rebuildProjectInlineReferenceIndex(projectId).catch((error) => {
          log.warn('[App] Reference index rebuild failed:', error);
        });

        events.emit('db:ready');
        log.info('[App] Database ready for project:', projectId);
        setDbReady(true);
        void pullAndHydrateProjectGraph(projectId).catch((error) => {
          log.warn('[App] Project graph hydrate failed:', error);
        });
      })
      .catch((error) => {
        log.error('[App] Failed to initialize database:', error);
        events.emit('db:error', { error: error.message });
      });
  }, [projectId, userId, nodeUsecases, storylineUsecases, elementUsecases, categoryUsecases]); // Re-init when projectId or user changes

  // listen for left topbar events
  useEffect(() => {
    const handleOpenSettings = () => setIsSettingsOpen(true);
    const handleToggleLeftSidebar = () => useUiStore.getState().toggleSidebar('left');
    const handleToggleRightSidebar = () => useUiStore.getState().toggleSidebar('right');
    events.on('settings:open', handleOpenSettings);
    events.on('left-sidebar:toggle', handleToggleLeftSidebar);
    events.on('right-sidebar:toggle', handleToggleRightSidebar);

    return () => {
      events.off('settings:open', handleOpenSettings);
      events.off('left-sidebar:toggle', handleToggleLeftSidebar);
      events.off('right-sidebar:toggle', handleToggleRightSidebar);
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

  // User-configurable shortcuts (close tab, find in editor, global search).
  // Subscribe to the store via getState() inside the handler so we read the
  // latest bindings without re-binding the listener on every change.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const { bindings } = useShortcutsStore.getState();

      if (matchesAccelerator(e, bindings.globalSearch)) {
        e.preventDefault();
        setFindPanelEditor(null);
        setIsGlobalSearchOpen(true);
        return;
      }

      if (matchesAccelerator(e, bindings.findInEditor)) {
        const editor = getActiveEditor();
        if (editor) {
          e.preventDefault();
          setFindPanelEditor(editor);
        }
        return;
      }

      if (matchesAccelerator(e, bindings.saveCurrentEditor)) {
        // Always swallow Cmd+S — the browser's default save-page dialog would
        // be useless inside the app. If no editor is active the call is a noop.
        e.preventDefault();
        saveActiveEditor();
        return;
      }

      if (matchesAccelerator(e, bindings.goBack)) {
        e.preventDefault();
        navigate(-1);
        return;
      }

      if (matchesAccelerator(e, bindings.goForward)) {
        e.preventDefault();
        navigate(1);
        return;
      }

      if (
        matchesAccelerator(e, bindings.prevTab) ||
        matchesAccelerator(e, bindings.nextTab)
      ) {
        const state = useUiStore.getState();
        const project = state.tabsByProject[projectId];
        if (!project || project.openTabs.length === 0) return;
        e.preventDefault();
        const activeKey = project.activeTabKey;
        const currentIdx = activeKey
          ? project.openTabs.findIndex((t) => tabKey(t) === activeKey)
          : -1;
        const direction = matchesAccelerator(e, bindings.nextTab) ? 1 : -1;
        // If no current selection (e.g. on project home), step from the edge
        // so Cmd+Alt+Right starts at the first tab and Cmd+Alt+Left at the last.
        const baseIdx = currentIdx === -1 ? (direction > 0 ? -1 : 0) : currentIdx;
        const nextIdx =
          (baseIdx + direction + project.openTabs.length) % project.openTabs.length;
        const nextTab = project.openTabs[nextIdx];
        openEntity({ entityType: nextTab.entityType, id: nextTab.id });
      }

      if (matchesAccelerator(e, bindings.closeActiveTab)) {
        const state = useUiStore.getState();
        const project = state.tabsByProject[projectId];
        const activeKey = project?.activeTabKey;
        if (!activeKey) return;
        const activeTab = project.openTabs.find(
          (t) => `${t.entityType}:${t.id}` === activeKey,
        );
        if (!activeTab) return;
        e.preventDefault();
        const { nextActive } = state.closeTab(projectId, {
          entityType: activeTab.entityType,
          id: activeTab.id,
        });
        if (nextActive) {
          openEntity({ entityType: nextActive.entityType, id: nextActive.id });
        } else {
          navigateToHome();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [projectId, openEntity, navigateToHome]);

  // Drop the find panel if the active editor goes away (e.g. user navigated
  // to a new view and the previous editor unmounted).
  useEffect(() => {
    return subscribeActiveEditor((editor) => {
      if (!editor) {
        setFindPanelEditor(null);
      }
    });
  }, []);

  if (!dbReady) {
    return (
      <div
        style={{
          height: '100vh',
          width: '100vw',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
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
      <AppTopbar hideNewEntityButton={isProjectDashboardHome} />
      {/* flex: 1 让它占据除底部时间轴外的所有垂直空间 */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Left Sidebar */}
        {/* 侧边栏不需要设高度，因为它在 flex 容器里会自动撑满高度 */}
        <Sidebar sidebarType="left">
          <div style={{ flexShrink: 0 }}>
            <LeftSidebarHeader />
          </div>
          <div style={{ flexShrink: 0 }}>
            <LeftSidebarSubHeader />
          </div>
          <div
            style={{
              flex: 1,
              minHeight: 0, // 关键：防止 flex 子元素溢出
              position: 'relative',
            }}
          >
            {activeLeftPanel === 'elements' ? (
              <ElementPanel />
            ) : activeLeftPanel === 'drift' ? (
              <DriftPanel />
            ) : (
              <NodesPanel />
            )}
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
            background: isEditorRoute ? 'hsl(var(--page))' : 'hsl(var(--surface))',
          }}
        >
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
        <Sidebar sidebarType="right">
          <div
            style={{
              flex: 1,
              minHeight: 0,
              position: 'relative',
            }}
          >
            <RightSidebarPanels />
          </div>
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
      <GlobalSearchModal
        isOpen={isGlobalSearchOpen}
        onClose={() => setIsGlobalSearchOpen(false)}
      />
      {findPanelEditor && (
        <EditorFindPanel
          editor={findPanelEditor}
          onClose={() => setFindPanelEditor(null)}
        />
      )}
      <SyncStatusHUD />

      {/* Floating Shadow orb — toggles shadow-mode (right panel grows a Shadow tab). */}
      <ShadowOrb />
    </div>
  );
}

import { ProjectPickerView } from './views/ProjectPickerView';
import { ProjectDashboard } from './views/ProjectDashboard';

export default function App() {
  return (
    <Routes>
      {/* 公开路由 */}
      <Route
        path="/login"
        element={
          <PublicRoute>
            <LoginPage />
          </PublicRoute>
        }
      />
      <Route
        path="/register"
        element={
          <PublicRoute>
            <RegisterPage />
          </PublicRoute>
        }
      />

      {/* 受保护的路由 */}
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <ProjectPickerView />
          </ProtectedRoute>
        }
      />

      {/* Project-scoped routes */}
      <Route
        path="/project/:projectId"
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="home" replace />} />
        <Route
          path="home"
          element={
            <EditorShell view="project-dashboard">
              <ProjectDashboard />
            </EditorShell>
          }
        />
        <Route path="editor" element={<Navigate to="../home" replace />} />
        <Route
          path="editor/:nodeId"
          element={
            <EditorShell view="node-editor">
              <NodeEditorView />
            </EditorShell>
          }
        />
        <Route
          path="editor/storyline/:storylineId"
          element={
            <EditorShell view="storyline-editor">
              <StorylineEditorView />
            </EditorShell>
          }
        />
        <Route
          path="element/:elementId"
          element={
            <EditorShell view="element-editor">
              <ElementEditorView />
            </EditorShell>
          }
        />
        <Route
          path="category/:categoryId"
          element={
            <EditorShell view="category-editor">
              <CategoryEditorView />
            </EditorShell>
          }
        />
      </Route>
    </Routes>
  );
}
