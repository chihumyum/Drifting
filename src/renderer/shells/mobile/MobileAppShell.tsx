import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { ProjectRuntimeProvider } from '../../app/providers/ProjectRuntimeProvider';
import { WorkspaceNavigationProvider } from '../../features/workspace/navigation/WorkspaceNavigationContext';
import { workspaceTargetFromPathname } from '../../features/workspace/navigation/workspace-route';
import { useAuthStore } from '../../store/auth';
import { useDataStore } from '../../store/data-store';
import { isChapter } from '../../domain/book-node';
import { AgentConfirmDialog } from '../../components/agent/AgentConfirmDialog';
import { EntitySnapshotHistoryModal } from '../../components/modals/EntitySnapshotHistoryModal';
import { DriftBindModal } from '../../components/modals/DriftBindModal';
import { SyncStatusHUD } from '../../components/sync/SyncStatusHUD';
import { MobilePaperDeck } from './workspace/MobilePaperDeck';
import { MobileTabOverview, type MobileSuperViewId } from './workspace/MobileTabOverview';
import { MobileSuperViewHost } from './workspace/MobileSuperViewHost';
import { useMobileWorkspaceSession } from './workspace/useMobileWorkspaceSession';
import '../../../styles/mobile-workspace.css';

function MobileWorkspaceRuntime({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const bookNodes = useDataStore((state) => state.bookNodes);
  const { state, navigator, open, activate, close, clear, reorder } =
    useMobileWorkspaceSession(projectId);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [activeSuperView, setActiveSuperView] = useState<MobileSuperViewId | null>(null);

  useEffect(() => {
    if (state.papers.length > 0) return;
    if (workspaceTargetFromPathname(projectId, location.pathname)) return;
    const firstChapter = bookNodes.filter(isChapter).sort((a, b) => a.bookOrder - b.bookOrder)[0];
    if (firstChapter) open({ entityType: 'node', id: firstChapter.id });
  }, [bookNodes, location.pathname, open, projectId, state.papers.length]);

  const setSuperView = useCallback((view: MobileSuperViewId | null) => {
    setOverviewOpen(false);
    setActiveSuperView(view);
  }, []);

  return (
    <WorkspaceNavigationProvider navigator={navigator}>
      <MobilePaperDeck
        projectId={projectId}
        session={state}
        onActivate={(paper) => activate(paper.target)}
        onOpenOverview={() => setOverviewOpen(true)}
      />

      {overviewOpen && (
        <MobileTabOverview
          session={state}
          onClose={() => setOverviewOpen(false)}
          onActivate={(paper) => {
            activate(paper.target);
            setOverviewOpen(false);
          }}
          onClosePaper={close}
          onCloseAll={clear}
          onReorder={reorder}
          onOpenSuperView={setSuperView}
          onOpenAllChapters={() => {
            open({ entityType: 'all-chapters', id: 'self' });
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
