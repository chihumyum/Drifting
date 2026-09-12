import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate } from 'react-router-dom';
import loglevel from 'loglevel';
import { initDatabase } from '../../lib/db';
import { events } from '../../lib/events';
import { useAgentToolBridge } from '../../lib/agent/useAgentToolBridge';
import { useDriftingAgentRuntime } from '../../lib/agent/useDriftingAgentRuntime';
import { useDataStore, type WorkspaceDataProjection } from '../../store/data-store';
import { useUiStore } from '../../store/ui-store';
import { sumCanonicalChapterWordCounts } from '../../domain/book-node';
import { useWritingStatsStore } from '../../store/writing-stats-store';
import { useProseMetricsStatusStore } from '../../store/prose-metrics-status-store';
import { useProjectStore } from '../../store/project-store';
import { useBookNode } from '../../usecase/useBookNode';
import { useStoryline } from '../../usecase/useStoryline';
import { useBookElement } from '../../usecase/useBookElement';
import { useBookContent } from '../../usecase/useBookContent';
import { useElementCategory } from '../../usecase/useElementCategory';
import { useEntityRelations } from '../../usecase/useEntityRelations';
import { useEntityRelationTypes } from '../../usecase/useEntityRelationTypes';
import { useComment } from '../../usecase/useComment';
import { useProject } from '../../usecase/useProject';
import { retainProjectReferenceIndex } from '../../services/reference-index.service';
import {
  NodeProseMetricRevisionConflictError,
  reconcileProjectProseMetrics,
} from '../../services/node-prose-metrics.service';
import { flushPendingAtomicSyncTransactions } from '../../services/atomic-sync-transaction-tracker';
import { captureWorkspaceProjection } from '../../services/workspace-projection.service';
import { FullScreenStatus } from '../components/FullScreenStatus';
import { releaseEntityLinkNames } from '../../lib/entity-link-names';

const log = loglevel.getLogger('ProjectRuntimeProvider');
log.setLevel(import.meta.env.DEV ? loglevel.levels.TRACE : loglevel.levels.WARN);

function pruneDeviceTabsToProjection(projectId: string, data: WorkspaceDataProjection): void {
  useUiStore.getState().pruneProjectTabs(projectId, {
    nodeIds: new Set(data.bookNodes.map((node) => node.id)),
    storylineIds: new Set(data.storylines.map((storyline) => storyline.id)),
    elementIds: new Set(data.bookElements.map((element) => element.id)),
    categoryIds: new Set(data.bookElementCategories.map((category) => category.id)),
  });
}

function WorkspaceBlockingStatus({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div
      role={action ? 'alert' : 'status'}
      aria-live={action ? 'assertive' : 'polite'}
      className="app-workspace-blocking-status"
    >
      <div className="app-fullscreen-status__content">
        <div className="app-fullscreen-status__title">{title}</div>
        <div className="app-fullscreen-status__detail">{detail}</div>
        {action && (
          <button
            type="button"
            className="set-btn set-btn--primary app-fullscreen-status__action"
            onClick={action.onClick}
          >
            {action.label}
          </button>
        )}
      </div>
    </div>
  );
}

type ProjectBootState =
  | { key: string; status: 'loading' }
  | { key: string; status: 'ready' }
  | { key: string; status: 'missing' }
  | { key: string; status: 'error'; error: string };

interface ProjectRuntimeProviderProps {
  projectId: string;
  userId: string;
  children: ReactNode;
}

export function ProjectRuntimeProvider({
  projectId,
  userId,
  children,
}: ProjectRuntimeProviderProps) {
  const { t } = useTranslation();
  const bootKey = `${userId}:${projectId}`;
  const [bootAttempt, setBootAttempt] = useState(0);
  const [bootState, setBootState] = useState<ProjectBootState>({
    key: bootKey,
    status: 'loading',
  });
  const workspaceProjectionStatus = useDataStore((state) => state.workspaceProjectionStatus);
  const workspaceRequestedProjectId = useDataStore(
    (state) => state.workspaceRequestedProjectId,
  );
  const workspaceProjectionError = useDataStore((state) => state.workspaceProjectionError);
  const nodeUsecases = useBookNode({ projectId, userId });
  const storylineUsecases = useStoryline({ projectId, userId });
  const elementUsecases = useBookElement({ projectId, userId });
  const categoryUsecases = useElementCategory({ projectId, userId });
  const relationUsecases = useEntityRelations({ projectId, userId });
  const relationTypeUsecases = useEntityRelationTypes({ projectId });
  const commentUsecases = useComment({ projectId, userId });
  const contentUsecases = useBookContent({ userId, projectId });
  const projectUsecases = useProject({ userId });

  useEffect(() => {
    if (!import.meta.env.DEV || import.meta.env.VITE_DRIFTING_FRONTEND_DEBUG !== '1') {
      return undefined;
    }
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void import('../../lib/frontend-debug/registry').then(({ registerFrontendDebugSlice }) => {
      if (cancelled) return;
      dispose = registerFrontendDebugSlice('project.boot', () => ({
        projectId,
        userId,
        attempt: bootAttempt,
        status: bootState.key === bootKey ? bootState.status : 'loading',
      }));
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [bootAttempt, bootKey, bootState, projectId, userId]);

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
    updateRelationType: relationUsecases.updateRelationType,
    createRelationType: relationTypeUsecases.createRelationType,
    updateRelationTypeDefinition: relationTypeUsecases.updateRelationType,
    deleteRelationType: relationTypeUsecases.deleteRelationType,
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
  });
  useDriftingAgentRuntime();

  useEffect(() => {
    if (!import.meta.env.DEV || bootState.status !== 'ready') return undefined;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void import('../../lib/agent/debug/headless-bridge').then((module) => {
      if (cancelled) return;
      dispose = module.installAgentHeadlessDebugBridge({ projectId });
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [bootState.status, projectId]);

  useEffect(() => {
    const tick = () => {
      if (useProseMetricsStatusStore.getState().byProject[projectId] !== 'ready') return;
      const dataState = useDataStore.getState();
      if (dataState.workspaceProjectId !== projectId) return;
      const nodes = dataState.bookNodes;
      const total = sumCanonicalChapterWordCounts(nodes);
      if (total.ready) {
        useWritingStatsStore.getState().recordTotalWords(projectId, total.count);
      }
    };
    tick();
    const unsubscribeData = useDataStore.subscribe((next, previous) => {
      if (next.bookNodes !== previous.bookNodes || next.workspaceProjectId !== previous.workspaceProjectId) tick();
    });
    const unsubscribeStatus = useProseMetricsStatusStore.subscribe((next, previous) => {
      if (next.byProject[projectId] !== previous.byProject[projectId]) tick();
    });
    return () => {
      unsubscribeData();
      unsubscribeStatus();
    };
  }, [projectId]);

  useEffect(() => {
    if (bootState.key !== bootKey || bootState.status !== 'ready') return undefined;
    return retainProjectReferenceIndex(projectId);
  }, [bootAttempt, bootKey, bootState.key, bootState.status, projectId]);

  useEffect(() => {
    if (bootState.key !== bootKey || bootState.status !== 'ready') return undefined;
    let disposed = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let metricTimer: ReturnType<typeof setTimeout> | null = null;
    let refreshRunning = false;
    let refreshRequested = false;
    let pendingEpoch: number | null = null;
    let projectMissing = false;

    const scheduleMetricReconciliation = () => {
      if (metricTimer !== null) clearTimeout(metricTimer);
      metricTimer = setTimeout(() => {
        metricTimer = null;
        if (disposed || useDataStore.getState().workspaceProjectId !== projectId) return;
        void reconcileProjectProseMetrics(projectId).catch((error) => {
          // A remote Yjs stream can advance while a metric projection is being
          // captured. This is derived data; defer it until the next quiet
          // window instead of failing an otherwise valid workspace refresh.
          if (error instanceof NodeProseMetricRevisionConflictError) {
            scheduleMetricReconciliation();
            return;
          }
          log.warn('Canonical prose metric reconciliation failed:', error);
        });
      }, 800);
    };

    const captureAndPublish = async (epoch: number) => {
      try {
        await flushPendingAtomicSyncTransactions();
        const capture = await captureWorkspaceProjection({ projectId, userId });
        if (!capture) {
          if (!disposed) {
            projectMissing = true;
            useDataStore.getState().clearWorkspaceProjection(projectId, epoch);
            setBootState({ key: bootKey, status: 'missing' });
          }
          return 'missing' as const;
        }
        if (disposed) return 'stale' as const;
        const accepted = useDataStore
          .getState()
          .commitWorkspaceProjection(projectId, epoch, capture.data);
        if (!accepted) return 'stale' as const;
        useProjectStore.getState().setCurrentProject(capture.project);
        pruneDeviceTabsToProjection(projectId, capture.data);
        return 'published' as const;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        useDataStore.getState().failWorkspaceProjection(projectId, epoch, message);
        throw error;
      }
    };

    const runRefresh = async () => {
      if (refreshRunning || disposed) return;
      refreshRunning = true;
      try {
        while (refreshRequested && !disposed) {
          refreshRequested = false;
          const epoch =
            pendingEpoch ??
            useDataStore.getState().requestWorkspaceProjection(projectId, 'refreshing');
          pendingEpoch = null;
          try {
            const result = await captureAndPublish(epoch);
            if (result === 'missing') {
              refreshRequested = false;
              pendingEpoch = null;
              break;
            }
          } catch (error) {
            log.warn('Remote project refresh failed:', error);
          }
        }
      } finally {
        refreshRunning = false;
        if (!disposed && !projectMissing) scheduleMetricReconciliation();
      }
    };

    const scheduleRefresh = (event: {
      projectId: string;
      projectionImpact: 'prose-only' | 'workspace';
    }) => {
      if (event.projectId !== projectId || disposed) return;
      if (event.projectionImpact === 'prose-only') {
        // The durable runtime has already merged these exact Yjs updates into
        // every open editor. Reconcile derived word-count/cache projections in
        // the background without replacing or blocking the structural store.
        scheduleMetricReconciliation();
        return;
      }
      refreshRequested = true;
      if (pendingEpoch === null) {
        // Show a project-scoped, interaction-blocking state as soon as the
        // first remote commit lands. The actual capture waits for a short
        // quiet window so one pull burst becomes one coherent projection.
        pendingEpoch = useDataStore
          .getState()
          .requestWorkspaceProjection(projectId, 'refreshing');
      }
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void runRefresh();
      }, 250);
    };

    events.on('sync:project-changed', scheduleRefresh);
    return () => {
      disposed = true;
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      if (metricTimer !== null) clearTimeout(metricTimer);
      events.off('sync:project-changed', scheduleRefresh);
    };
  }, [bootKey, bootState, projectId, userId]);

  useEffect(() => {
    let active = true;
    const epoch = useDataStore
      .getState()
      .requestWorkspaceProjection(projectId, 'loading');
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBootState({ key: bootKey, status: 'loading' });

    const initialize = async () => {
      try {
        await initDatabase(userId);
        const capture = await captureWorkspaceProjection({ projectId, userId });
        if (!capture) {
          if (active) {
            useDataStore.getState().clearWorkspaceProjection(projectId, epoch);
            setBootState({ key: bootKey, status: 'missing' });
          }
          return;
        }
        if (!active) return;
        const accepted = useDataStore
          .getState()
          .commitWorkspaceProjection(projectId, epoch, capture.data);
        if (!accepted) return;
        useProjectStore.getState().setCurrentProject(capture.project);
        pruneDeviceTabsToProjection(projectId, capture.data);
        events.emit('db:ready');
        setBootState({ key: bootKey, status: 'ready' });
        // Derived metrics run after the workspace authority is published. A
        // remote Yjs revision conflict never invalidates the captured domain
        // projection and will be retried by the remote quiet-window worker.
        void reconcileProjectProseMetrics(projectId).catch((error) => {
          if (!(error instanceof NodeProseMetricRevisionConflictError)) {
            log.warn('Canonical prose metric reconciliation failed:', error);
          }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error('Project initialization failed:', error);
        events.emit('db:error', { error: message });
        if (active) {
          useDataStore.getState().failWorkspaceProjection(projectId, epoch, message);
          setBootState({ key: bootKey, status: 'error', error: message });
        }
      }
    };

    void initialize();
    return () => {
      active = false;
      releaseEntityLinkNames(projectId);
    };
  }, [bootAttempt, bootKey, projectId, userId]);

  const currentBoot: ProjectBootState =
    bootState.key === bootKey ? bootState : { key: bootKey, status: 'loading' };
  if (currentBoot.status === 'loading') {
    return <FullScreenStatus title={t('appShell.loadingProject')} />;
  }
  if (currentBoot.status === 'missing') {
    return <Navigate to="/" replace />;
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

  const projectRefreshFailed =
    workspaceRequestedProjectId === projectId &&
    workspaceProjectionStatus === 'error';
  const projectRefreshActive =
    workspaceRequestedProjectId === projectId &&
    workspaceProjectionStatus === 'refreshing';

  return (
    <>
      {children}
      {projectRefreshFailed ? (
        <WorkspaceBlockingStatus
          title={t('appShell.projectRefreshFailedTitle')}
          detail={`${t('appShell.projectRefreshFailedDetail')} ${workspaceProjectionError ?? ''}`}
          action={{
            label: t('appShell.retry'),
            onClick: () => setBootAttempt((attempt) => attempt + 1),
          }}
        />
      ) : projectRefreshActive ? (
        <WorkspaceBlockingStatus
          title={t('appShell.syncingProject')}
          detail={t('appShell.syncingProjectDetail')}
        />
      ) : null}
    </>
  );
}
