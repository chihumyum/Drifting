import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { ProjectRuntimeProvider } from '../../app/providers/ProjectRuntimeProvider';
import { WorkspaceNavigationProvider } from '../../features/workspace/navigation/WorkspaceNavigationContext';
import { workspaceTargetFromPathname } from '../../features/workspace/navigation/workspace-route';
import type { WorkspaceTarget } from '../../features/workspace/navigation/workspace-target';
import { useAuthStore } from '../../store/auth';
import { AgentConfirmDialog } from '../../components/agent/AgentConfirmDialog';
import { EntitySnapshotHistoryModal } from '../../components/modals/EntitySnapshotHistoryModal';
import { DriftBindModal } from '../../components/modals/DriftBindModal';
import { SyncStatusHUD } from '../../components/sync/SyncStatusHUD';
import { MobilePaperDeck } from './workspace/MobilePaperDeck';
import { MobileTabOverview, type MobileSuperViewId } from './workspace/MobileTabOverview';
import { MobileSuperViewHost } from './workspace/MobileSuperViewHost';
import { useMobileWorkspaceSession } from './workspace/useMobileWorkspaceSession';
import { freezeLiveMobilePaperContent } from './workspace/mobile-paper-snapshot';
import '../../../styles/mobile-workspace.css';

function MobileWorkspaceRuntime({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { state, navigator, open, activate, close, clear, reorder, rememberScroll } =
    useMobileWorkspaceSession(projectId);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [activeSuperView, setActiveSuperView] = useState<MobileSuperViewId | null>(null);
  const [frozenProseByKey, setFrozenProseByKey] = useState<Record<string, string>>({});

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
    () => ({ ...navigator, open: openPaper, activate: activatePaper }),
    [activatePaper, navigator, openPaper],
  );
  const closePaper = useCallback(
    (key: string) => {
      close(key);
      setFrozenProseByKey((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
    },
    [close],
  );
  const clearPapers = useCallback(() => {
    clear();
    setFrozenProseByKey({});
  }, [clear]);

  useEffect(() => {
    if (state.papers.length > 0) return;
    if (workspaceTargetFromPathname(projectId, location.pathname)) return;
    const timer = window.setTimeout(() => openPaper({ entityType: 'dashboard', id: 'self' }), 0);
    return () => window.clearTimeout(timer);
  }, [location.pathname, openPaper, projectId, state.papers.length]);

  const setSuperView = useCallback((view: MobileSuperViewId | null) => {
    setOverviewOpen(false);
    setActiveSuperView(view);
  }, []);

  return (
    <WorkspaceNavigationProvider navigator={mobileNavigator}>
      <MobilePaperDeck
        projectId={projectId}
        session={state}
        frozenProseByKey={frozenProseByKey}
        onFreezeActivePaper={freezeActivePaper}
        onActivate={(paper) => activatePaper(paper.target)}
        onOpenPaper={openPaper}
        onRememberScroll={rememberScroll}
        onOpenOverview={() => setOverviewOpen(true)}
      />

      {overviewOpen && (
        <MobileTabOverview
          session={state}
          onClose={() => setOverviewOpen(false)}
          onActivate={(paper) => {
            activatePaper(paper.target);
            setOverviewOpen(false);
          }}
          onClosePaper={closePaper}
          onCloseAll={clearPapers}
          onReorder={reorder}
          onOpenSuperView={setSuperView}
          onOpenAllChapters={() => {
            openPaper({ entityType: 'all-chapters', id: 'self' });
            setOverviewOpen(false);
          }}
          onOpenSettings={() => navigate('/settings', { state: { from: location.pathname } })}
          onBackToShelf={() => navigate('/', { replace: true })}
        />
      )}

      <MobileSuperViewHost active={activeSuperView} onActiveChange={setSuperView} />
      <AgentConfirmDialog />
      <EntitySnapshotHistoryModal />
      <DriftBindModal />
      <SyncStatusHUD />
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
      <MobileWorkspaceRuntime projectId={projectId} />
    </ProjectRuntimeProvider>
  );
}
