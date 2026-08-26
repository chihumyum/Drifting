import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { ProjectRuntimeProvider } from '../../app/providers/ProjectRuntimeProvider';
import { WorkspaceNavigationProvider } from '../../features/workspace/navigation/WorkspaceNavigationContext';
import { SuperViewRelationUiProvider } from '../../features/graph/SuperViewRelationUiContext';
import { workspaceTargetFromPathname } from '../../features/workspace/navigation/workspace-route';
import type { WorkspaceTarget } from '../../features/workspace/navigation/workspace-target';
import { useAuthStore } from '../../store/auth';
import { AgentConfirmDialog } from '../../components/agent/AgentConfirmDialog';
import { EntitySnapshotHistoryModal } from '../../components/modals/EntitySnapshotHistoryModal';
import { DriftBindModal } from '../../components/modals/DriftBindModal';
import { MobilePaperDeck } from './workspace/MobilePaperDeck';
import { MobileTabOverview } from './workspace/MobileTabOverview';
import { MobileSuperViewHost } from './workspace/MobileSuperViewHost';
import { MobileProjectTrashView } from './workspace/MobileProjectTrashView';
import { MobileProjectHome } from './workspace/MobileProjectHome';
import { MobileStructureOverlay } from './workspace/MobileStructureOverlay';
import { useMobileWorkspaceSession } from './workspace/useMobileWorkspaceSession';
import { freezeLiveMobilePaperContent } from './workspace/mobile-paper-snapshot';
import { requestMobileWorkspaceBack } from './workspace/mobile-workspace-back';
import { saveActiveEditor } from '../../lib/active-editor';
import {
  createInitialMobileWorkspaceUiState,
  mobileWorkspaceReducer,
  selectMobileUnifiedBarProjection,
  type MobileSuperViewId,
} from './workspace/mobile-workspace-controller';
import { useMobileWorkspaceBack } from './workspace/useMobileWorkspaceBack';
import {
  captureMobileSuperViewReturnPoint,
  mobileSuperViewReturnPointMatches,
  type MobileSuperViewReturnPoint,
} from './workspace/mobile-super-view-state';
import '../../../styles/mobile-workspace.css';

function readActivePaperScrollTop(): number | undefined {
  const activePage = document.querySelector<HTMLElement>(
    '.m-paper-row__page[data-active="true"]',
  );
  return activePage?.querySelector<HTMLElement>('.editor-scroll, .dash')?.scrollTop;
}

function MobileWorkspaceRuntime({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { state, navigator, open, activate, close, clear, reorder, rememberScroll } =
    useMobileWorkspaceSession(projectId);
  const [workspaceUi, dispatchWorkspaceUi] = useReducer(
    mobileWorkspaceReducer,
    undefined,
    createInitialMobileWorkspaceUiState,
  );
  const [frozenProseByKey, setFrozenProseByKey] = useState<Record<string, string>>({});
  const [projectSearchQuery, setProjectSearchQuery] = useState<string | null>(null);
  const superViewReturnPointRef = useRef<MobileSuperViewReturnPoint | null>(null);
  const freezeActivePaperRef = useRef<(() => string | undefined) | null>(null);
  const [lastSuperViewRestoreStatus, setLastSuperViewRestoreStatus] = useState<
    'none' | 'preserved' | 'changed'
  >('none');
  const leaveProject = useCallback(() => navigate('/', { replace: true }), [navigate]);

  const showProjectHome = useCallback(
    (replace = false) => {
      freezeActivePaperRef.current?.();
      dispatchWorkspaceUi({ type: 'show-project-home' });
      navigate(`/project/${projectId}`, { replace });
    },
    [navigate, projectId],
  );

  useMobileWorkspaceBack({
    state: workspaceUi,
    dispatch: dispatchWorkspaceUi,
    onShowProjectHome: () => showProjectHome(false),
    onLeaveProject: leaveProject,
  });

  useEffect(() => {
    if (!import.meta.env.DEV || import.meta.env.VITE_DRIFTING_FRONTEND_DEBUG !== '1') {
      return undefined;
    }
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void import('../../lib/frontend-debug/registry').then(({ registerFrontendDebugSlice }) => {
      if (cancelled) return;
      dispose = registerFrontendDebugSlice('mobile.workspace', () => ({
        projectId,
        papers: state.papers.map((paper) => ({
          key: paper.key,
          target: paper.target,
          scrollTop: paper.scrollTop,
          frozen: Object.prototype.hasOwnProperty.call(frozenProseByKey, paper.key),
        })),
        activeKey: state.activeKey,
        controller: workspaceUi,
        unifiedBar: selectMobileUnifiedBarProjection(workspaceUi),
        superViewReturnPoint: superViewReturnPointRef.current,
        lastSuperViewRestoreStatus,
      }));
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [frozenProseByKey, lastSuperViewRestoreStatus, projectId, state, workspaceUi]);

  const freezeActivePaper = useCallback((): string | undefined => {
    const active = state.papers.find((paper) => paper.key === state.activeKey);
    if (!active) return undefined;
    const contentJson = freezeLiveMobilePaperContent(active);
    if (contentJson === undefined) return undefined;
    setFrozenProseByKey((current) =>
      current[active.key] === contentJson ? current : { ...current, [active.key]: contentJson },
    );
    return contentJson;
  }, [state.activeKey, state.papers]);
  useEffect(() => {
    freezeActivePaperRef.current = freezeActivePaper;
  }, [freezeActivePaper]);

  const openPaper = useCallback(
    (target: WorkspaceTarget) => {
      freezeActivePaper();
      open(target);
    },
    [freezeActivePaper, open],
  );
  const activatePaper = useCallback(
    (target: WorkspaceTarget) => {
      freezeActivePaper();
      activate(target);
    },
    [activate, freezeActivePaper],
  );
  const mobileNavigator = useMemo(
    () => ({
      ...navigator,
      open: openPaper,
      activate: activatePaper,
      showProjectHome: (options?: { replace?: boolean }) =>
        showProjectHome(options?.replace ?? false),
    }),
    [activatePaper, navigator, openPaper, showProjectHome],
  );
  const closePaper = useCallback(
    (key: string) => {
      const closesLastPaper = state.papers.length === 1 && state.papers[0]?.key === key;
      close(key);
      if (closesLastPaper) dispatchWorkspaceUi({ type: 'show-project-home' });
      setFrozenProseByKey((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
    },
    [close, state.papers],
  );
  const clearPapers = useCallback(() => {
    clear();
    setFrozenProseByKey({});
  }, [clear]);

  useEffect(() => {
    const root = `/project/${projectId}`;
    if (location.pathname === `${root}/home`) {
      dispatchWorkspaceUi({ type: 'show-project-home' });
      navigate(root, { replace: true });
      return;
    }
    const target = workspaceTargetFromPathname(projectId, location.pathname);
    if (target) {
      dispatchWorkspaceUi({ type: 'show-paper' });
      return;
    }
    if (location.pathname === root || location.pathname === `${root}/`) {
      dispatchWorkspaceUi({ type: 'show-project-home' });
    }
  }, [location.pathname, navigate, projectId]);

  const activeSuperView =
    workspaceUi.surface.kind === 'super-view' ? workspaceUi.surface.view : null;
  const setSuperView = useCallback(
    (view: MobileSuperViewId | null) => {
      if (view) {
        if (activeSuperView === null && workspaceUi.surface.kind === 'paper') {
          const liveScrollTop = readActivePaperScrollTop();
          if (state.activeKey && liveScrollTop !== undefined) {
            rememberScroll(state.activeKey, liveScrollTop);
          }
          freezeActivePaper();
          void saveActiveEditor();
          superViewReturnPointRef.current = captureMobileSuperViewReturnPoint(
            state,
            location,
            liveScrollTop,
          );
          setLastSuperViewRestoreStatus('none');
        } else if (activeSuperView === null) {
          superViewReturnPointRef.current = null;
          setLastSuperViewRestoreStatus('none');
        }
        dispatchWorkspaceUi({ type: 'show-super-view', view });
        return;
      }

      const returnTo =
        workspaceUi.surface.kind === 'super-view'
          ? workspaceUi.surface.returnTo
          : 'paper';
      const returnPoint = superViewReturnPointRef.current;
      if (returnTo === 'project-home') {
        superViewReturnPointRef.current = null;
        dispatchWorkspaceUi({ type: 'show-project-home' });
        return;
      }
      const liveScrollTop = readActivePaperScrollTop();
      if (state.activeKey && liveScrollTop !== undefined) {
        rememberScroll(state.activeKey, liveScrollTop);
      }
      const preserved =
        returnPoint !== null &&
        mobileSuperViewReturnPointMatches(returnPoint, state, location, liveScrollTop);
      setLastSuperViewRestoreStatus(preserved ? 'preserved' : 'changed');
      if (!preserved && import.meta.env.DEV) {
        console.error('[mobile-super-view] paper return point changed while overlay was open', {
          returnPoint,
          currentSession: state,
          currentLocation: location,
          liveScrollTop,
        });
      }
      superViewReturnPointRef.current = null;
      dispatchWorkspaceUi({ type: 'show-paper' });
    }, [activeSuperView, freezeActivePaper, location, rememberScroll, state, workspaceUi.surface],
  );

  const overviewOpen = workspaceUi.surface.kind === 'overview';
  const trashOpen =
    workspaceUi.transient.kind === 'dialog' &&
    workspaceUi.transient.dialog === 'project-trash';

  return (
    <WorkspaceNavigationProvider navigator={mobileNavigator}>
      {workspaceUi.surface.kind === 'project-home' && (
        <MobileProjectHome
          paperCount={state.papers.length}
          onBackToShelf={leaveProject}
          onOpenOverview={() => {
            setProjectSearchQuery(null);
            dispatchWorkspaceUi({ type: 'show-overview' });
          }}
          onOpenProjectView={(view) => setSuperView(view)}
          onOpenStructure={(tab) =>
            dispatchWorkspaceUi({ type: 'set-overlay', overlay: tab })
          }
        />
      )}
      <MobilePaperDeck
        projectId={projectId}
        session={state}
        frozenProseByKey={frozenProseByKey}
        onActivate={(paper) => activatePaper(paper.target)}
        onOpenPaper={openPaper}
        onRememberScroll={rememberScroll}
        onOpenOverview={() => {
          setProjectSearchQuery(null);
          dispatchWorkspaceUi({ type: 'show-overview' });
        }}
        workspaceUi={workspaceUi}
        onWorkspaceUiAction={dispatchWorkspaceUi}
      />

      {overviewOpen && (
        <MobileTabOverview
          session={state}
          searchQuery={projectSearchQuery}
          onSearchQueryChange={setProjectSearchQuery}
          onClose={() => requestMobileWorkspaceBack('visible')}
          onActivate={(paper) => {
            activatePaper(paper.target);
            dispatchWorkspaceUi({ type: 'show-paper' });
          }}
          onActivateSearchResult={(target) => {
            openPaper(target);
            dispatchWorkspaceUi({ type: 'show-paper' });
          }}
          onClosePaper={closePaper}
          onCloseAll={() => {
            clearPapers();
            dispatchWorkspaceUi({ type: 'show-project-home' });
          }}
          onReorder={reorder}
          onOpenSuperView={setSuperView}
          onOpenAllChapters={() => {
            openPaper({ entityType: 'all-chapters', id: 'self' });
            dispatchWorkspaceUi({ type: 'show-paper' });
          }}
          onOpenSettings={() => navigate('/settings', { state: { from: location.pathname } })}
          onOpenTrash={() => {
            dispatchWorkspaceUi({ type: 'open-project-trash' });
          }}
          onBackToShelf={leaveProject}
        />
      )}

      {(workspaceUi.overlay === 'chapters' ||
        workspaceUi.overlay === 'elements' ||
        workspaceUi.overlay === 'drifts') && (
        <MobileStructureOverlay
          tab={workspaceUi.overlay}
          target={
            state.papers.find((paper) => paper.key === state.activeKey)?.target ?? null
          }
          onClose={() => dispatchWorkspaceUi({ type: 'set-overlay', overlay: 'none' })}
          onOpenTarget={(target) => {
            openPaper(target);
            dispatchWorkspaceUi({ type: 'show-paper' });
          }}
          onOpenAllChapters={() => {
            openPaper({ entityType: 'all-chapters', id: 'self' });
            dispatchWorkspaceUi({ type: 'show-paper' });
          }}
          onOpenGraph={() => setSuperView('graph')}
        />
      )}

      <MobileSuperViewHost
        active={activeSuperView}
        onActiveChange={setSuperView}
        returnPointCaptured={activeSuperView !== null}
      />
      {trashOpen && (
        <MobileProjectTrashView onClose={() => requestMobileWorkspaceBack('visible')} />
      )}
      <AgentConfirmDialog />
      <EntitySnapshotHistoryModal />
      <DriftBindModal />
    </WorkspaceNavigationProvider>
  );
}

export function MobileAppShell() {
  const { projectId } = useParams<{ projectId: string }>();
  const userId = useAuthStore((state) => state.user?.id);
  if (!projectId) throw new Error('Project ID is required in URL');
  if (!userId) throw new Error('User must be authenticated');
  return (
    <ProjectRuntimeProvider projectId={projectId} userId={userId}>
      <SuperViewRelationUiProvider key={projectId} projectId={projectId}>
        <MobileWorkspaceRuntime projectId={projectId} />
      </SuperViewRelationUiProvider>
    </ProjectRuntimeProvider>
  );
}
