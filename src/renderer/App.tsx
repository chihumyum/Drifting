import { Component, useEffect, useRef, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
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
import { ChapterPanel } from './components/leftBars/ChapterPanel';
import { DriftPanel } from './components/leftBars/DriftPanel';
import { RightSidebarPanels } from './components/rightBars/RightSidebarPanels';
import { SuperElementView, SuperMemoMaterialView } from './views/SuperViews/SuperViews';
import { Sidebar } from './components/Sidebar';
import { BottomTimeline } from './components/BottomTimeline/BottomTimeline';
import { EditorMainArea } from './components/editor/EditorMainArea';
import { useSyncSplitFocusedUrl } from './components/editor/useSyncSplitFocusedUrl';
import { BottomStatusBar } from './components/BottomStatusBar';
import { SettingsModal } from './components/modals/SettingsModal';
import { PreAlphaOnboardingDialog } from './components/modals/PreAlphaOnboardingDialog';
import { EntitySnapshotHistoryModal } from './components/modals/EntitySnapshotHistoryModal';
import { DriftBindModal } from './components/modals/DriftBindModal';
import { ImportDialog } from './components/modals/ImportDialog';
import { EditChapterStorylineModal } from './components/modals/EditChapterStorylineModal';
import { SyncStatusHUD } from './components/sync/SyncStatusHUD';
import { useAgentToolBridge } from './lib/agent/useAgentToolBridge';
import { useDriftingAgentRuntime } from './lib/agent/useDriftingAgentRuntime';
import { EditorFindPanel } from './components/search/EditorFindPanel';
import { GlobalSearchModal } from './components/search/GlobalSearchModal';
import { AgentConfirmDialog } from './components/agent/AgentConfirmDialog';
import { initAccentColor } from './lib/theme';
import { useUiStore, tabKey, focusedLeafOf } from './store/ui-store';
import { useSettingsStore } from './store/settings-store';
import { useShortcutsStore } from './store/shortcuts-store';
import { setI18nLocale } from './lib/i18n';
import { applyEditorPreferences } from './lib/editor-preferences';
import { ensureImportedProseFontLoaded } from './lib/prose-fonts';
import { startPreferencesSync } from './services/preferences-sync.service';
import { startSyncObserver } from './services/sync-observer.service';
import { matchesAccelerator } from './lib/shortcuts';
import { getActiveEditor, saveActiveEditor, subscribeActiveEditor } from './lib/active-editor';
import { forceSyncAllDocuments } from './services/yjs-sync.service';
import type { Editor } from '@tiptap/core';
import { useProjectNavigation } from './hooks/useProjectNavigation';
import { useNotificationFeed } from './hooks/useNotificationFeed';
import { useShadowJobs } from './usecase/useShadowJobs';
import { useShadowReview } from './usecase/useShadowReview';
import { useAuthStore } from './store/auth';
import { useDataStore } from './store/data-store';
import { useWritingStatsStore } from './store/writing-stats-store';
import { useBookNode } from './usecase/useBookNode';
import { useStoryline } from './usecase/useStoryline';
import { useBookElement } from './usecase/useBookElement';
import { useBookContent } from './usecase/useBookContent';
import { useElementCategory } from './usecase/useElementCategory';
import { useProjectAsset } from './usecase/useProjectAsset';
import { useLibraryItem } from './usecase/useLibraryItem';
import { useEntityRelations } from './usecase/useEntityRelations';
import { useComment } from './usecase/useComment';
import { loadBookActs } from './usecase/useBookAct';
import { loadDriftGroups } from './usecase/useDriftGroup';
import { loadTimelineMarkers } from './hooks/useTimelineMarkers';
import { useProject } from './usecase/useProject';
import { AppTopbar } from './views/AppTopbar';
import { EditorShell } from './views/EditorShell';
import { isAuthRequired } from './lib/config';
import { pullAndHydrateProjectGraph } from './services/entity-sync.service';
import { rebuildProjectInlineReferenceIndex } from './services/reference-index.service';
import { resumeProjectAssetUploads } from './services/durable-asset-upload.service';
import { platform } from './platform';
import { getPlatformRuntime } from './platform/runtime';
import { flushApplicationPersistenceForLifecycle } from './lib/persistence-lifecycle';
import loglevel from 'loglevel';

const log = loglevel.getLogger('App');

// The goal smoke harness can execute real staged writes. Keep it out of the
// production module graph instead of merely hiding its UI.
if (import.meta.env.DEV) {
  void import('./lib/goal/dev-harness');
}

// URL builder for a leaf tab — used by the keyboard tab-cycle shortcut when
// stepping into a split tab. Lives next to App because it's the only call
// site outside useProjectNavigation, and duplicating the four short cases
// here is cheaper than pulling navigation logic into a shared util.
function urlForLeaf(
  projectId: string,
  leaf: {
    entityType: 'node' | 'storyline' | 'element' | 'category' | 'dashboard' | 'all-chapters';
    id: string;
  },
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
log.setLevel(import.meta.env.DEV ? loglevel.levels.TRACE : loglevel.levels.WARN);

function FullScreenStatus({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div
      role={action ? 'alert' : 'status'}
      aria-live={action ? 'assertive' : 'polite'}
      style={{
        minHeight: '100vh',
        width: '100vw',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
        background: 'hsl(var(--paper))',
        color: 'hsl(var(--ink-1))',
      }}
    >
      <div style={{ width: 'min(440px, 100%)', textAlign: 'center' }}>
        <div style={{ fontFamily: 'var(--font-sans)', fontSize: 22 }}>{title}</div>
        {detail && (
          <div
            style={{
              marginTop: 10,
              color: 'hsl(var(--ink-3))',
              fontFamily: 'var(--font-sans)',
              fontSize: 13,
              lineHeight: 1.6,
              overflowWrap: 'anywhere',
            }}
          >
            {detail}
          </div>
        )}
        {action && (
          <button
            type="button"
            className="set-btn set-btn--primary"
            style={{ marginTop: 18 }}
            onClick={action.onClick}
          >
            {action.label}
          </button>
        )}
      </div>
    </div>
  );
}

interface RootErrorBoundaryState {
  error: Error | null;
}

class RootErrorBoundary extends Component<{ children: ReactNode }, RootErrorBoundaryState> {
  state: RootErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): RootErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    log.error('[App] Unhandled renderer error:', error, info.componentStack);
  }

  private retry = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return <RootErrorFallback error={this.state.error} onRetry={this.retry} />;
    }
    return this.props.children;
  }
}

function RootErrorFallback({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <FullScreenStatus
      title={t('appShell.unexpectedTitle')}
      detail={`${t('appShell.unexpectedDetail')} ${error.message}`}
      action={{ label: t('appShell.retry'), onClick: onRetry }}
    />
  );
}

type ProjectBootState =
  | { key: string; status: 'loading' }
  | { key: string; status: 'ready' }
  | { key: string; status: 'error'; error: string };

// 认证路由守卫
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const authRequired = isAuthRequired();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const userId = useAuthStore((state) => state.user?.id);
  const [isChecking, setIsChecking] = useState(true);
  const checkSession = useAuthStore((state) => state.checkSession);

  useEffect(() => {
    checkSession().finally(() => setIsChecking(false));
  }, [checkSession]);

  // Hydrate the cached subscription plan once the user is known. Drives the
  // trash gate, the rail badge, the user menu label. Refires on userId
  // change so plan resets when switching accounts.
  useEffect(() => {
    void import('./lib/feature-access').then((m) => {
      if (!isAuthenticated || !userId) {
        m.resetFeatureAccess();
        return;
      }
      void m.refreshFeatureAccess(userId);
    });
  }, [isAuthenticated, userId]);

  if (isChecking) {
    return <FullScreenStatus title={t('appShell.checkingAuthentication')} />;
  }

  if (authRequired && (!isAuthenticated || !userId)) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

function PublicRoute({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const authRequired = isAuthRequired();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const userId = useAuthStore((state) => state.user?.id);
  const [isChecking, setIsChecking] = useState(true);
  const checkSession = useAuthStore((state) => state.checkSession);

  useEffect(() => {
    checkSession().finally(() => setIsChecking(false));
  }, [checkSession]);

  if (isChecking) {
    return <FullScreenStatus title={t('appShell.checkingAuthentication')} />;
  }

  if (!authRequired || (isAuthenticated && !!userId)) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}

function Layout() {
  const { t } = useTranslation();
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
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsTargetRail, setSettingsTargetRail] = useState<string | null>(null);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const bootKey = `${userId}:${projectId}`;
  const [bootAttempt, setBootAttempt] = useState(0);
  const [bootState, setBootState] = useState<ProjectBootState>({
    key: bootKey,
    status: 'loading',
  });
  const [findPanelEditor, setFindPanelEditor] = useState<Editor | null>(null);
  const [isGlobalSearchOpen, setIsGlobalSearchOpen] = useState(false);
  const { openEntity, navigateToHome, navigateToAllChapters } = useProjectNavigation();
  const navigate = useNavigate();
  // When the active tab is a split, keep the URL synced with the focused
  // side. Mounted at the Layout level so it runs in both single- and
  // split-pane modes (EditorShell wouldn't run when Outlet isn't rendered).
  useSyncSplitFocusedUrl();
  // Collect Copilot/Shadow task lifecycle events into the global notification
  // feed (pill + center). Mounted here so history accrues even on platforms
  // where the topbar pill isn't rendered.
  useNotificationFeed();
  const nodeUsecases = useBookNode({ projectId: projectId, userId: userId });
  const storylineUsecases = useStoryline({ projectId: projectId, userId: userId });
  const elementUsecases = useBookElement({ projectId: projectId, userId: userId });
  const categoryUsecases = useElementCategory({ projectId: projectId, userId: userId });
  const projectAssetUsecases = useProjectAsset({ projectId: projectId, userId: userId });
  const libraryItemUsecases = useLibraryItem({ projectId: projectId, userId: userId });
  const relationUsecases = useEntityRelations({ projectId: projectId, userId: userId });
  const commentUsecases = useComment({ projectId: projectId, userId: userId });
  const contentUsecases = useBookContent({ userId: userId, projectId: projectId });
  const projectUsecases = useProject({ userId: userId });
  const shadowJobUsecases = useShadowJobs({ projectId: projectId });
  const shadowReviewUsecases = useShadowReview({ projectId: projectId, userId: userId });

  // Publish renderer-side tool handlers for Shadow and future Agent transports;
  // reads/writes go through the same store + usecases as manual edits.
  useAgentToolBridge(projectId, {
    updateElement: elementUsecases.updateElement,
    createElement: elementUsecases.createElement,
    renameNode: nodeUsecases.renameNode,
    updateNode: nodeUsecases.updateNode,
    updateContentByNodeId: contentUsecases.updateContentByNodeId,
    addNodeToStoryline: storylineUsecases.addNodeToStoryline,
    removeNodeFromStoryline: storylineUsecases.removeNodeFromStoryline,
    setNodeStorylines: storylineUsecases.setNodeStorylines,
    addRelation: relationUsecases.addRelation,
    removeRelation: relationUsecases.removeRelation,
    updateRelationKind: relationUsecases.updateRelationKind,
    removeElement: elementUsecases.removeElement,
    createStoryline: storylineUsecases.createStoryline,
    updateStoryline: storylineUsecases.updateStoryline,
    createCategory: categoryUsecases.createCategory,
    updateCategory: categoryUsecases.updateCategory,
    updateProject: projectUsecases.updateProject,
    createNode: nodeUsecases.createNode,
    createComment: commentUsecases.createComment,
    deleteComment: commentUsecases.deleteComment,
    resolveComment: commentUsecases.resolveComment,
    reopenComment: commentUsecases.reopenComment,
    convertToTodo: commentUsecases.convertToTodo,
    revertToNote: commentUsecases.revertToNote,
    setCommentKind: commentUsecases.setCommentKind,
    commitShadowReview: shadowReviewUsecases.commitShadowReview,
  });
  useDriftingAgentRuntime();

  // DEV-only structured Agent harness. The native renderer remains the owner
  // of real stores/usecases/Yjs; a loopback broker can drive it without UI
  // automation once this project's boot has completed.
  useEffect(() => {
    if (!import.meta.env.DEV || bootState.status !== 'ready') return undefined;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void import('./lib/agent/debug/headless-bridge').then((module) => {
      if (cancelled) return;
      dispose = module.installAgentHeadlessDebugBridge({ projectId });
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [bootState.status, projectId]);

  // Writing-stats recorder. Subscribes directly to the data store so it ticks
  // regardless of which view is mounted — without this, snapshots would only
  // refresh when the user happened to load the dashboard. Throttled in the
  // store itself (a no-op when today's total is unchanged), so the listener
  // can fire on every keystroke without blowing up localStorage writes.
  useEffect(() => {
    if (!projectId) return undefined;
    const tick = () => {
      const nodes = useDataStore.getState().bookNodes;
      const total = nodes.reduce((sum, n) => sum + (n.wordCount || 0), 0);
      useWritingStatsStore.getState().recordTotalWords(projectId, total);
    };
    tick(); // seed on mount so today's snapshot exists even before any edit.
    return useDataStore.subscribe(tick);
  }, [projectId]);

  useEffect(() => {
    // Start the sync history recorder. Safe to call multiple times; it
    // only attaches the bus listener once. The HUD still listens directly
    // for toasts — both consumers share the same `sync:operation` stream.
    startSyncObserver();
  }, []);

  useEffect(() => {
    const resumeUploads = () => {
      void resumeProjectAssetUploads(projectId).catch((error) => {
        log.warn('[App] Durable asset upload resume failed:', error);
      });
    };
    window.addEventListener('online', resumeUploads);
    return () => window.removeEventListener('online', resumeUploads);
  }, [projectId]);

  useEffect(() => {
    let active = true;
    // This state mirrors an external boot attempt, rather than deriving local
    // render data. It must reset before a retry starts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBootState({ key: bootKey, status: 'loading' });

    const initialize = async () => {
      log.info('[App] Initializing database for user:', userId);
      try {
        await initDatabase(userId);
        // Initialize project-specific data (stores etc). Story-graph edges
        // come from entity_relation now and load with relationUsecases.
        await Promise.all([
          // Seed the project metadata from local SQLite so the dashboard title
          // shows the real name on first paint (no placeholder flash) — the
          // network graph pull below still refreshes it afterwards.
          projectUsecases.loadProject(projectId),
          nodeUsecases.loadNodes(),
          storylineUsecases.loadStorylines(),
          elementUsecases.loadInitial(),
          categoryUsecases.loadCategories(),
          projectAssetUsecases.loadInitial(),
          libraryItemUsecases.loadInitial(),
          relationUsecases.loadInitial(),
          commentUsecases.loadInitial(),
          shadowJobUsecases.loadInitial(),
          loadBookActs(projectId),
          loadDriftGroups(projectId),
          loadTimelineMarkers(projectId),
        ]);
        // Node-storyline mapping depends on nodes being loaded first.
        await storylineUsecases.loadNodeStorylineMapping();
        // Resume the durable shadow queue now that nodes are loaded (so the
        // waiting_review check is reliable) — re-dispatch interrupted reviews.
        void shadowJobUsecases.resumeQueued();
        await rebuildProjectInlineReferenceIndex(projectId).catch((error) => {
          log.warn('[App] Reference index rebuild failed:', error);
        });

        if (!active) return;
        events.emit('db:ready');
        log.info('[App] Database ready for project:', projectId);
        setBootState({ key: bootKey, status: 'ready' });
        void pullAndHydrateProjectGraph(projectId)
          .catch((error) => {
            log.warn('[App] Project graph hydrate failed:', error);
          })
          .finally(() => {
            if (!active) return;
            void resumeProjectAssetUploads(projectId).catch((error) => {
              log.warn('[App] Durable asset upload resume failed:', error);
            });
          });
        // Settings cross-device sync. Independent of project state, but we
        // wait until auth+db are ready so we know cookies are set and the
        // store has had a chance to hydrate from localStorage.
        void startPreferencesSync().catch((error) => {
          log.warn('[App] Preferences sync init failed:', error);
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error('[App] Failed to initialize database:', error);
        events.emit('db:error', { error: message });
        if (active) setBootState({ key: bootKey, status: 'error', error: message });
      }
    };

    void initialize();
    return () => {
      active = false;
    };
  }, [
    bootAttempt,
    bootKey,
    projectId,
    userId,
    projectUsecases,
    nodeUsecases,
    storylineUsecases,
    elementUsecases,
    categoryUsecases,
    projectAssetUsecases,
    libraryItemUsecases,
    relationUsecases,
    commentUsecases,
    shadowJobUsecases,
  ]); // Re-init when projectId or user changes

  // listen for left topbar events
  useEffect(() => {
    const handleOpenSettings = (payload?: { railId?: string }) => {
      setSettingsTargetRail(payload?.railId ?? null);
      setIsSettingsOpen(true);
    };
    const handleOpenImport = () => setIsImportOpen(true);
    const handleOpenSearch = () => {
      setFindPanelEditor(null);
      setIsGlobalSearchOpen(true);
    };
    const handleToggleLeftSidebar = () => useUiStore.getState().toggleSidebar('left');
    const handleToggleRightSidebar = () => useUiStore.getState().toggleSidebar('right');
    events.on('settings:open', handleOpenSettings);
    events.on('import:open', handleOpenImport);
    events.on('search:open', handleOpenSearch);
    events.on('left-sidebar:toggle', handleToggleLeftSidebar);
    events.on('right-sidebar:toggle', handleToggleRightSidebar);

    return () => {
      events.off('settings:open', handleOpenSettings);
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
  const chapterStorylineEditorNodeId = useUiStore((state) => state.chapterStorylineEditorNodeId);
  const setChapterStorylineEditorNodeId = useUiStore(
    (state) => state.setChapterStorylineEditorNodeId,
  );

  // Track the last singleton-nav shortcut so a quick repeat (Digit1/Digit2)
  // promotes the preview tab to dedicated — mirrors the dblclick gesture on
  // the AppTopbar Home / 通览全书 buttons.
  const lastSingletonShortcut = useRef<{ code: 'Digit1' | 'Digit2'; t: number } | null>(null);
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
      const maybePromote = (code: 'Digit1' | 'Digit2') => {
        const prev = lastSingletonShortcut.current;
        const now = performance.now();
        if (prev && prev.code === code && now - prev.t <= 500 && projectId) {
          useUiStore.getState().promoteTab(projectId);
          lastSingletonShortcut.current = null;
        } else {
          lastSingletonShortcut.current = { code, t: now };
        }
      };
      switch (e.code) {
        case 'Digit1':
          e.preventDefault();
          dismissSuperView();
          navigateToHome();
          maybePromote('Digit1');
          return;
        case 'Digit2':
          e.preventDefault();
          dismissSuperView();
          navigateToAllChapters();
          maybePromote('Digit2');
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
  }, [activeSuperView, setActiveSuperView, navigateToHome, navigateToAllChapters, projectId]);

  // User-configurable shortcuts (close tab, find in editor, global search).
  // Subscribe to the store via getState() inside the handler so we read the
  // latest bindings without re-binding the listener on every change.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Escape inside a Super View belongs to that view's local navigation
      // stack. In particular, a user-bound goBack=Escape must not bypass an
      // open popover / Drift Panel and dismiss the whole overlay at once.
      if (e.key === 'Escape' && useUiStore.getState().activeSuperView !== 'none') return;

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
        void saveActiveEditor()
          .then(() => forceSyncAllDocuments())
          .catch((error) => log.warn('[App] Cmd+S sync failed:', error));
        return;
      }

      if (matchesAccelerator(e, bindings.toggleBottomTimeline)) {
        e.preventDefault();
        useUiStore.getState().toggleBottomTimelineHidden();
        return;
      }

      if (matchesAccelerator(e, bindings.goBack)) {
        e.preventDefault();
        // Inside a super view (StoryGraphView / SuperElementView /
        // SuperMemoMaterialView), goBack closes the overlay instead of
        // walking router history — the overlay sits on top of the same
        // route, so navigate(-1) would scroll the underlying tab back one
        // step instead of dismissing the view the user is actually looking at.
        if (useUiStore.getState().activeSuperView !== 'none') {
          useUiStore.getState().setActiveSuperView('none');
          return;
        }
        navigate(-1);
        return;
      }

      if (matchesAccelerator(e, bindings.goForward)) {
        e.preventDefault();
        navigate(1);
        return;
      }

      if (matchesAccelerator(e, bindings.prevTab) || matchesAccelerator(e, bindings.nextTab)) {
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
        const nextIdx = (baseIdx + direction + project.openTabs.length) % project.openTabs.length;
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

  const currentBoot: ProjectBootState =
    bootState.key === bootKey ? bootState : { key: bootKey, status: 'loading' };
  if (currentBoot.status === 'loading') {
    return <FullScreenStatus title={t('appShell.loadingProject')} />;
  }
  if (currentBoot.status === 'error') {
    return (
      <FullScreenStatus
        title={t('appShell.projectLoadFailedTitle')}
        detail={`${t('appShell.projectLoadFailedDetail')} ${currentBoot.error}`}
        action={{
          label: t('appShell.retry'),
          onClick: () => {
            setBootState({ key: bootKey, status: 'loading' });
            setBootAttempt((attempt) => attempt + 1);
          },
        }}
      />
    );
  }

  return (
    // One flat workspace plane. The titlebar sits above a three-column body;
    // both sidebars now run all the way to the bottom while the center column
    // owns the editor, optional timeline and compact status strip.
    <div
      className="app-root"
      style={{
        height: '100vh',
        width: '100vw',
        display: 'flex',
        flexDirection: 'column',
        // Keep scrolling inside the editor/panels rather than at window level.
        overflow: 'hidden',
      }}
    >
      <AppTopbar />
      <div className="app-row" style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
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
              <ChapterPanel />
            )}
          </div>
        </Sidebar>

        {/* The center column stays on the workspace plane. Only the manuscript
            page inside the editor carries document elevation. */}
        <main
          className="app-mid"
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            position: 'relative',
            minWidth: 0, // 关键：防止 flex 子元素被宽内容撑爆
          }}
        >
          {/* Editor stage. In single-pane mode EditorMainArea renders
              <Outlet /> internally, so the matched route's view component
              still scrolls inside this container. In split mode it renders
              two panes directly and suppresses the Outlet — each pane's
              view scrolls independently within its half of the stage. */}
          <div
            className="workspace-stage"
            style={{
              flex: 1,
              // Every routed surface below owns its real scroll container
              // (.editor-scroll or .dash). Keeping this stage scrollable
              // creates a second Y owner: momentum chains here at the inner
              // boundary and its scrollbar width makes centred paper twitch.
              overflowY: 'hidden',
              overflowX: 'hidden',
              position: 'relative',
            }}
          >
            <EditorMainArea />
          </div>
          {/* The optional timeline is a dock in the center column, not a
              fourth elevated island. */}
          {!bottomTimelineHidden && (
            <div className="workspace-dock" style={{ flexShrink: 0, zIndex: 10 }}>
              <BottomTimeline />
            </div>
          )}
          {/* Writing/sync status and its adjacent Timeline toggle follow the editor column. Open
              sidebars own their bottom corners instead of being cut off by a
              full-width footer; other project commands live in AppTopbar. */}
          <BottomStatusBar />
          {/* In-document Cmd+F find panel — anchored to this editor column
              (.app-mid is position:relative) so it floats over the text area
              instead of the viewport's top-right, which used to occlude the
              right sidebar. */}
          {findPanelEditor && (
            <EditorFindPanel editor={findPanelEditor} onClose={() => setFindPanelEditor(null)} />
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

      {/* Overlays / Modals (绝对定位层) */}
      <AgentConfirmDialog />
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
      <ImportDialog open={isImportOpen} onClose={() => setIsImportOpen(false)} />
      <EntitySnapshotHistoryModal />
      <DriftBindModal />
      {chapterStorylineEditorNodeId && (
        <EditChapterStorylineModal
          nodeId={chapterStorylineEditorNodeId}
          onClose={() => setChapterStorylineEditorNodeId(null)}
        />
      )}
      <GlobalSearchModal isOpen={isGlobalSearchOpen} onClose={() => setIsGlobalSearchOpen(false)} />
      <SyncStatusHUD />
    </div>
  );
}

import { ProjectPickerView } from './views/ProjectPickerView';
import { ProjectDashboard } from './views/ProjectDashboard';

// Mirror themeMode → <html class="dark"> from the topmost component, not
// inside Layout. The bookshelf route renders outside Layout and still needs
// to follow the selected light/dark mode. Side effects only — no render output.
function AppearanceEffects() {
  const themeMode = useSettingsStore((state) => state.themeMode);
  const setUiTheme = useUiStore((state) => state.setTheme);

  useEffect(() => {
    initAccentColor();
  }, []);

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

  // Keep the native macOS controls aligned with the shared renderer titlebar.
  // Tauri mobile and decorated non-macOS windows never receive this command.
  useEffect(() => {
    const runtime = getPlatformRuntime();
    if (!runtime.isMacDesktop || !runtime.desktopWindowControls) return;
    // The native overlay titlebar and the inset renderer island have different
    // vertical origins. This measured 26px offset centers the 14px buttons on
    // the shared 42px header pill instead of leaving them high by one inset.
    void platform.window
      .setTrafficLightPosition({ x: 18, y: 26 })
      .catch((error) => log.warn('[App] native window-control positioning is unavailable:', error));
  }, []);

  return null;
}

function EditorPreferenceEffects() {
  // Select fields one at a time so each subscriber keeps a stable primitive
  // identity. This effect lives above routing so the Settings preview also
  // updates when opened from the bookshelf.
  const editorFontSource = useSettingsStore((s) => s.editorFontSource);
  const editorSystemFontFamily = useSettingsStore((s) => s.editorSystemFontFamily);
  const setEditorFontSource = useSettingsStore((s) => s.setEditorFontSource);
  const bodyFontSize = useSettingsStore((s) => s.bodyFontSize);
  const editorLineHeight = useSettingsStore((s) => s.lineHeight);
  const maxLineWidth = useSettingsStore((s) => s.maxLineWidth);
  const paragraphIndent = useSettingsStore((s) => s.paragraphIndent);
  const editorIndentStep = useSettingsStore((s) => s.editorIndentStep);
  const paragraphSpacing = useSettingsStore((s) => s.paragraphSpacing);
  const caretColor = useSettingsStore((s) => s.caretColor);
  const entityLinkInteractive = useSettingsStore((s) => s.entityLinkInteractive);
  const entityLinkColorMode = useSettingsStore((s) => s.entityLinkColorMode);

  useEffect(() => {
    applyEditorPreferences({
      editorFontSource,
      editorSystemFontFamily,
      bodyFontSize,
      lineHeight: editorLineHeight,
      maxLineWidth,
      paragraphIndent,
      editorIndentStep,
      paragraphSpacing,
      caretColor,
      entityLinkInteractive,
      entityLinkColorMode,
    });
  }, [
    editorFontSource,
    editorSystemFontFamily,
    bodyFontSize,
    editorLineHeight,
    maxLineWidth,
    paragraphIndent,
    editorIndentStep,
    paragraphSpacing,
    caretColor,
    entityLinkInteractive,
    entityLinkColorMode,
  ]);

  useEffect(() => {
    if (editorFontSource !== 'imported') return;
    let cancelled = false;
    void ensureImportedProseFontLoaded()
      .then((metadata) => {
        // The selection can outlive browser storage cleanup. Heal that stale
        // pointer instead of leaving Settings on an unavailable font forever.
        if (
          !cancelled &&
          !metadata &&
          useSettingsStore.getState().editorFontSource === 'imported'
        ) {
          setEditorFontSource('system-serif');
        }
      })
      .catch((error) => log.warn('[App] imported prose font could not be loaded:', error));
    return () => {
      cancelled = true;
    };
  }, [editorFontSource, setEditorFontSource]);

  return null;
}

// The bookshelf and auth routes render outside Layout, so locale syncing has
// to live at the app shell level rather than in the project editor layout.
function LocaleEffects() {
  const uiLocale = useSettingsStore((state) => state.uiLocale);
  useEffect(() => {
    setI18nLocale(uiLocale);
  }, [uiLocale]);
  return null;
}

// Native lifecycle handling belongs to the app shell, not the project layout:
// login and bookshelf routes can own an open database/session too. Suspended
// events request the same local durability barrier but never carry a shutdown
// confirmation ID, so they cannot accidentally confirm a concurrent close.
function PersistenceLifecycleEffects() {
  useEffect(() => {
    const unsubscribe = platform.lifecycle.onFlushBeforeQuit((request) => {
      void flushApplicationPersistenceForLifecycle()
        .then(() => {
          if (!request.confirmationRequired || request.requestId == null) return;
          void platform.lifecycle
            .confirmFlushBeforeQuit(request.requestId)
            .catch((error) => log.warn('[App] confirmFlushBeforeQuit failed:', error));
        })
        .catch((error) => {
          // Do not acknowledge a failed shutdown barrier. Native code retains a
          // bounded fallback deadline, while this makes the durability failure
          // visible instead of reporting a successful flush.
          log.warn('[App] lifecycle persistence flush failed:', error);
        });
    });

    const onBeforeUnload = () => {
      // Browser/WebView unload itself is synchronous. Begin the active-editor
      // save as a last best-effort fallback; native close uses the awaited path.
      void saveActiveEditor().catch(() => undefined);
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    return () => {
      unsubscribe();
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, []);

  return null;
}

function AppContents() {
  return (
    <>
      <LocaleEffects />
      <AppearanceEffects />
      <EditorPreferenceEffects />
      <PersistenceLifecycleEffects />
      <PreAlphaOnboardingDialog />
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
    </>
  );
}

export default function App() {
  return (
    <RootErrorBoundary>
      <AppContents />
    </RootErrorBoundary>
  );
}
