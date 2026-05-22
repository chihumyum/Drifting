import { useEffect, useState } from 'react';
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom';
import { NodeEditorView } from './views/NodeEditorView';
import { ElementEditorView } from './views/ElementEditorView';
import { CategoryEditorView } from './views/CategoryEditorView';
import { StorylineEditorView } from './views/StorylineEditorView';
import { AllChaptersEditorView } from './views/AllChaptersEditorView';
import { StoryGraphView } from './views/StoryGraphView';
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
import { SuperElementView, SuperMemoMaterialView } from './views/SuperViews/SuperViews';
import { Sidebar } from './components/Sidebar';
import { BottomTimeline } from './components/BottomTimeline/BottomTimeline';
import { EditorMainArea } from './components/editor/EditorMainArea';
import { useSyncSplitFocusedUrl } from './components/editor/useSyncSplitFocusedUrl';
import { BottomStatusBar } from './components/BottomStatusBar';
import { SettingsModal } from './components/modals/SettingsModal';
import { ExportDialog } from './components/modals/ExportDialog';
import { ImportDialog } from './components/modals/ImportDialog';
import { SyncStatusHUD } from './components/sync/SyncStatusHUD';
import { EditorFindPanel } from './components/search/EditorFindPanel';
import { GlobalSearchModal } from './components/search/GlobalSearchModal';
import { initAccentColor } from './lib/theme';
import { useUiStore, tabKey, focusedLeafOf } from './store/ui-store';
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
import { useBookMemo } from './usecase/useBookMemo';
import { useBookMaterial } from './usecase/useBookMaterial';
import { useEntityRelations } from './usecase/useEntityRelations';
import { AppTopbar } from './views/AppTopbar';
import { EditorShell } from './views/EditorShell';
import { isAuthRequired } from './lib/config';
import { pullAndHydrateProjectGraph } from './services/entity-sync.service';
import { rebuildProjectInlineReferenceIndex } from './services/reference-index.service';
import loglevel from 'loglevel';

const log = loglevel.getLogger('App');

// URL builder for a leaf tab — used by the keyboard tab-cycle shortcut when
// stepping into a split tab. Lives next to App because it's the only call
// site outside useProjectNavigation, and duplicating the four short cases
// here is cheaper than pulling navigation logic into a shared util.
function urlForLeaf(
  projectId: string,
  leaf: { entityType: 'node' | 'storyline' | 'element' | 'category' | 'dashboard' | 'all-chapters'; id: string },
): string | null {
  switch (leaf.entityType) {
    case 'node':
      return `/project/${projectId}/editor/${leaf.id}`;
    case 'storyline':
      return `/project/${projectId}/editor/storyline/${leaf.id}`;
    case 'element':
      return `/project/${projectId}/element/${leaf.id}`;
    case 'category':
      return `/project/${projectId}/category/${encodeURIComponent(leaf.id)}`;
    case 'dashboard':
      return `/project/${projectId}/home`;
    case 'all-chapters':
      return `/project/${projectId}/editor/all`;
    default:
      return null;
  }
}
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
  const { openEntity, navigateToHome, navigateToAllChapters } = useProjectNavigation();
  const navigate = useNavigate();
  // When the active tab is a split, keep the URL synced with the focused
  // side. Mounted at the Layout level so it runs in both single- and
  // split-pane modes (EditorShell wouldn't run when Outlet isn't rendered).
  useSyncSplitFocusedUrl();
  const nodeUsecases = useBookNode({ projectId: projectId, userId: userId });
  const storylineUsecases = useStoryline({ projectId: projectId, userId: userId });
  const elementUsecases = useBookElement({ projectId: projectId, userId: userId });
  const categoryUsecases = useElementCategory({ projectId: projectId, userId: userId });
  const memoUsecases = useBookMemo({ projectId: projectId, userId: userId });
  const materialUsecases = useBookMaterial({ projectId: projectId, userId: userId });
  const relationUsecases = useEntityRelations({ projectId: projectId, userId: userId });

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
          memoUsecases.loadInitial(),
          materialUsecases.loadInitial(),
          relationUsecases.loadInitial(),
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
  }, [
    projectId,
    userId,
    nodeUsecases,
    storylineUsecases,
    elementUsecases,
    categoryUsecases,
    memoUsecases,
    materialUsecases,
    relationUsecases,
  ]); // Re-init when projectId or user changes

  // listen for left topbar events
  useEffect(() => {
    const handleOpenSettings = (payload?: { railId?: string }) => {
      setSettingsTargetRail(payload?.railId ?? null);
      setIsSettingsOpen(true);
    };
    const handleOpenExport = () => setIsExportOpen(true);
    const handleOpenImport = () => setIsImportOpen(true);
    const handleOpenSearch = () => {
      setFindPanelEditor(null);
      setIsGlobalSearchOpen(true);
    };
    const handleToggleLeftSidebar = () => useUiStore.getState().toggleSidebar('left');
    const handleToggleRightSidebar = () => useUiStore.getState().toggleSidebar('right');
    events.on('settings:open', handleOpenSettings);
    events.on('export:open', handleOpenExport);
    events.on('import:open', handleOpenImport);
    events.on('search:open', handleOpenSearch);
    events.on('left-sidebar:toggle', handleToggleLeftSidebar);
    events.on('right-sidebar:toggle', handleToggleRightSidebar);

    return () => {
      events.off('settings:open', handleOpenSettings);
      events.off('export:open', handleOpenExport);
      events.off('import:open', handleOpenImport);
      events.off('search:open', handleOpenSearch);
      events.off('left-sidebar:toggle', handleToggleLeftSidebar);
      events.off('right-sidebar:toggle', handleToggleRightSidebar);
    };
  }, []);

  // Global Super-View shortcuts. Cmd+Option+1..5 jump to:
  //   1: Project Dashboard (home)
  //   2: 纵览全书 (all-chapters)
  //   3: Story Graph View
  //   4: Super Element View
  //   5: Super Memo & Material View
  // 1/2 navigate routes (and dismiss any active super view); 3..5 toggle the
  // corresponding super view overlay. Cmd+Shift+3/4 were rejected because
  // macOS reserves them system-wide for screenshots.
  const activeSuperView = useUiStore((state) => state.activeSuperView);
  const setActiveSuperView = useUiStore((state) => state.setActiveSuperView);
  const activeLeftPanel = useUiStore((state) => state.activeLeftPanel);
  const bottomTimelineHidden = useUiStore((state) => state.bottomTimelineHidden);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Option = altKey on Mac. Require Cmd+Option exactly — no Shift/Ctrl —
      // so we don't grab unrelated chords.
      if (!e.metaKey || !e.altKey || e.shiftKey || e.ctrlKey) return;
      // `code` is layout-independent — Digit1..Digit5 always reflect the
      // physical 1..5 keys regardless of keyboard layout.
      const dismissSuperView = () => {
        if (activeSuperView !== 'none') setActiveSuperView('none');
      };
      const toggleSuper = (view: 'graph' | 'element' | 'memo-material') => {
        setActiveSuperView(activeSuperView === view ? 'none' : view);
      };
      switch (e.code) {
        case 'Digit1':
          e.preventDefault();
          dismissSuperView();
          navigateToHome();
          return;
        case 'Digit2':
          e.preventDefault();
          dismissSuperView();
          navigateToAllChapters();
          return;
        case 'Digit3':
          e.preventDefault();
          toggleSuper('graph');
          return;
        case 'Digit4':
          e.preventDefault();
          toggleSuper('element');
          return;
        case 'Digit5':
          e.preventDefault();
          toggleSuper('memo-material');
          return;
        default:
          return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeSuperView, setActiveSuperView, navigateToHome, navigateToAllChapters]);

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
        // Tab activation is a different operation than "open entity":
        //   - splits can't go through openEntity (would replace focused
        //     side of the *current* split instead of switching),
        //   - leaf node tabs can't either (when current focus is the
        //     all-chapters singleton, openEntity short-circuits to a scroll
        //     instead of navigating away).
        // Bypass openEntity entirely — setActiveTab + navigate(url).
        if (nextTab.kind === 'split') {
          state.setActiveTab(projectId, { splitId: nextTab.id });
          const leaf = focusedLeafOf(nextTab);
          const url = urlForLeaf(projectId, leaf);
          if (url) navigate(url);
        } else {
          state.setActiveTab(projectId, { entityType: nextTab.entityType, id: nextTab.id });
          const url = urlForLeaf(projectId, nextTab);
          if (url) navigate(url);
        }
      }

      if (matchesAccelerator(e, bindings.closeActiveTab)) {
        const state = useUiStore.getState();
        const project = state.tabsByProject[projectId];
        const activeKey = project?.activeTabKey;
        if (!activeKey) return;
        const activeTab = project.openTabs.find((t) => tabKey(t) === activeKey);
        if (!activeTab) return;
        e.preventDefault();
        const closeRef =
          activeTab.kind === 'split'
            ? { splitId: activeTab.id }
            : { entityType: activeTab.entityType, id: activeTab.id };
        const { nextActive } = state.closeTab(projectId, closeRef);
        if (nextActive) {
          openEntity({ entityType: nextActive.entityType, id: nextActive.id });
        } else {
          // Active tab closed with no successor — last tab gone. Navigate
          // to the bare project URL so neither EditorShell nor the Layout
          // URL→tab sync re-creates the just-closed entity. The empty
          // editor state will show.
          navigate(`/project/${projectId}`, { replace: true });
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [projectId, openEntity, navigate]);

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
        // Hide any overflow at the outermost container. The bottom status
        // bar adds a fixed compact row, so without this clamp the combined
        // height would push the page into having a window-level scrollbar.
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
          {/* In single-pane mode EditorMainArea renders <Outlet /> internally,
              so the matched route's view component still scrolls inside this
              container. In split mode it renders two panes directly and
              suppresses the Outlet — each pane's view scrolls independently
              within its half of the editor surface. */}
          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              overflowX: 'hidden',
              position: 'relative',
            }}
          >
            <EditorMainArea />
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
      {activeSuperView === 'graph' && <StoryGraphView />}
      {activeSuperView === 'element' && <SuperElementView />}
      {activeSuperView === 'memo-material' && <SuperMemoMaterialView />}
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
        {/* Bare project URL renders the editor surface with no auto-route.
            When no tabs are open the empty state shows; when tabs exist,
            useSyncSplitFocusedUrl drives focus from the active tab. */}
        <Route index element={null} />
        <Route
          path="home"
          element={
            <EditorShell view="project-dashboard">
              <ProjectDashboard />
            </EditorShell>
          }
        />
        <Route path="editor" element={<Navigate to=".." replace />} />
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
