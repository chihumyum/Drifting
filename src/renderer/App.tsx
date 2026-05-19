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
import { AllChaptersEditorView } from './views/AllChaptersEditorView';
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
import { BottomStatusBar } from './components/BottomStatusBar';
import { SettingsModal } from './components/modals/SettingsModal';
import { ExportDialog } from './components/modals/ExportDialog';
import { ImportDialog } from './components/modals/ImportDialog';
import { SyncStatusHUD } from './components/sync/SyncStatusHUD';
import { EditorFindPanel } from './components/search/EditorFindPanel';
import { GlobalSearchModal } from './components/search/GlobalSearchModal';
import { initAccentColor } from './lib/theme';
import { useUiStore, tabKey } from './store/ui-store';
import { useSettingsStore } from './store/settings-store';
import { useShortcutsStore } from './store/shortcuts-store';
import { setI18nLocale } from './lib/i18n';
import { applyEditorPreferences } from './lib/editor-preferences';
import { startPreferencesSync } from './services/preferences-sync.service';
import { startSyncObserver } from './services/sync-observer.service';
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
  const [settingsTargetRail, setSettingsTargetRail] = useState<string | null>(null);
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
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

  // Theme: resolve 'light' | 'dark' | 'system' to the actual mode, then
  // mirror to ui-store.theme so existing read sites stay correct.
  const themeMode = useSettingsStore((state) => state.themeMode);
  const setUiTheme = useUiStore((state) => state.setTheme);
  const shadowMode = useUiStore((state) => state.shadowMode);
  const shadowAffectsTheme = useSettingsStore((state) => state.shadowAffectsTheme);
  const animationsEnabled = useSettingsStore((state) => state.animationsEnabled);

  useEffect(() => {
    const root = document.documentElement;
    const apply = (mode: 'light' | 'dark') => {
      if (mode === 'dark') root.classList.add('dark');
      else root.classList.remove('dark');
      setUiTheme(mode);
    };
    if (themeMode === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      apply(mq.matches ? 'dark' : 'light');
      const handler = (e: MediaQueryListEvent) => apply(e.matches ? 'dark' : 'light');
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
    apply(themeMode);
    return undefined;
  }, [themeMode, setUiTheme]);

  // Shadow mode shifts the full palette via token overrides in index.css.
  // When the user disables `shadowAffectsTheme`, we leave the html attribute
  // off so palette stays put — only the right panel still picks up shadow.
  useEffect(() => {
    const root = document.documentElement;
    if (shadowMode && shadowAffectsTheme) {
      root.setAttribute('data-shadow-mode', 'on');
    } else {
      root.removeAttribute('data-shadow-mode');
    }
  }, [shadowMode, shadowAffectsTheme]);

  // Animations master switch: setting an attribute lets CSS short-circuit
  // transitions/keyframes without touching every site.
  useEffect(() => {
    const root = document.documentElement;
    if (animationsEnabled) root.removeAttribute('data-no-anim');
    else root.setAttribute('data-no-anim', 'on');
  }, [animationsEnabled]);

  // UI locale → i18next
  const uiLocale = useSettingsStore((state) => state.uiLocale);
  useEffect(() => {
    setI18nLocale(uiLocale);
  }, [uiLocale]);

  // Editor typography → CSS variables on <html>. Select fields one at a
  // time so each subscriber is a stable primitive identity — wrapping
  // them in an object literal here would mint a new snapshot every render
  // and trigger React's "getSnapshot should be cached" infinite loop.
  const bodyFontSize = useSettingsStore((s) => s.bodyFontSize);
  const editorLineHeight = useSettingsStore((s) => s.lineHeight);
  const maxLineWidth = useSettingsStore((s) => s.maxLineWidth);
  const paragraphIndent = useSettingsStore((s) => s.paragraphIndent);
  const focusLine = useSettingsStore((s) => s.focusLine);
  const entityHighlight = useSettingsStore((s) => s.entityHighlight);
  const marginNotes = useSettingsStore((s) => s.marginNotes);
  useEffect(() => {
    applyEditorPreferences({
      bodyFontSize,
      lineHeight: editorLineHeight,
      maxLineWidth,
      paragraphIndent,
      focusLine,
      entityHighlight,
      marginNotes,
    });
  }, [
    bodyFontSize,
    editorLineHeight,
    maxLineWidth,
    paragraphIndent,
    focusLine,
    entityHighlight,
    marginNotes,
  ]);

  useEffect(() => {
    // Start the sync history recorder. Safe to call multiple times; it
    // only attaches the bus listener once. The HUD still listens directly
    // for toasts — both consumers share the same `sync:operation` stream.
    startSyncObserver();
  }, []);

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
        // Settings cross-device sync. Independent of project state, but we
        // wait until auth+db are ready so we know cookies are set and the
        // store has had a chance to hydrate from localStorage.
        void startPreferencesSync().catch((error) => {
          log.warn('[App] Preferences sync init failed:', error);
        });
      })
      .catch((error) => {
        log.error('[App] Failed to initialize database:', error);
        events.emit('db:error', { error: error.message });
      });
  }, [projectId, userId, nodeUsecases, storylineUsecases, elementUsecases, categoryUsecases]); // Re-init when projectId or user changes

  // listen for left topbar events
  useEffect(() => {
    const handleOpenSettings = (payload?: { railId?: string }) => {
      setSettingsTargetRail(payload?.railId ?? null);
      setIsSettingsOpen(true);
    };
    const handleOpenExport = () => setIsExportOpen(true);
    const handleOpenImport = () => setIsImportOpen(true);
    const handleToggleLeftSidebar = () => useUiStore.getState().toggleSidebar('left');
    const handleToggleRightSidebar = () => useUiStore.getState().toggleSidebar('right');
    events.on('settings:open', handleOpenSettings);
    events.on('export:open', handleOpenExport);
    events.on('import:open', handleOpenImport);
    events.on('left-sidebar:toggle', handleToggleLeftSidebar);
    events.on('right-sidebar:toggle', handleToggleRightSidebar);

    return () => {
      events.off('settings:open', handleOpenSettings);
      events.off('export:open', handleOpenExport);
      events.off('import:open', handleOpenImport);
      events.off('left-sidebar:toggle', handleToggleLeftSidebar);
      events.off('right-sidebar:toggle', handleToggleRightSidebar);
    };
  }, []);

  // Global Shortcut for Graph View (Cmd + Shift + \)
  const activeSuperView = useUiStore((state) => state.activeSuperView);
  const setActiveSuperView = useUiStore((state) => state.setActiveSuperView);
  const activeLeftPanel = useUiStore((state) => state.activeLeftPanel);
  const bottomTimelineHidden = useUiStore((state) => state.bottomTimelineHidden);

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

      if (matchesAccelerator(e, bindings.toggleBottomTimeline)) {
        e.preventDefault();
        useUiStore.getState().toggleBottomTimelineHidden();
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
        // Hide any overflow at the outermost container. The new bottom
        // status bar adds a fixed 24px row, so without this clamp the
        // 100vh + 24px combined height would push the page into having
        // a window-level scrollbar.
        overflow: 'hidden',
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
          {/* 底部时间轴：嵌入中间栏底部，左右栏延伸至最底。
              状态栏 toggle 隐藏整条时间轴；不再保留旧的「色带」薄态。 */}
          {!bottomTimelineHidden && (
            <div style={{ flexShrink: 0, zIndex: 10 }}>
              <BottomTimeline />
            </div>
          )}
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

      {/* Always-visible bottom status bar — full width, sits below the
          editor + sidebars. Hosts the BottomTimeline toggle, so even when
          the timeline is hidden there's a one-click affordance to bring it
          back. */}
      <BottomStatusBar />

      {/* Overlays / Modals (绝对定位层) */}
      {activeSuperView === 'graph' && <GraphView />}
      {activeSuperView === 'element' && <SuperElementView />}
      {activeSuperView === 'reference' && <SuperReferenceView />}
      <SettingsModal
        isOpen={isSettingsOpen}
        initialRailId={settingsTargetRail}
        onClose={() => {
          setIsSettingsOpen(false);
          setSettingsTargetRail(null);
        }}
      />
      <ExportDialog open={isExportOpen} onClose={() => setIsExportOpen(false)} />
      <ImportDialog open={isImportOpen} onClose={() => setIsImportOpen(false)} />
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
          path="editor/all"
          element={
            <EditorShell view="all-chapters-editor">
              <AllChaptersEditorView />
            </EditorShell>
          }
        />
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
