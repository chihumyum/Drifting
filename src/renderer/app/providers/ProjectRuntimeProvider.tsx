import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate } from 'react-router-dom';
import loglevel from 'loglevel';
import { initDatabase } from '../../lib/db';
import { events } from '../../lib/events';
import { useAgentToolBridge } from '../../lib/agent/useAgentToolBridge';
import { useDriftingAgentRuntime } from '../../lib/agent/useDriftingAgentRuntime';
import { useDataStore } from '../../store/data-store';
import { sumCanonicalChapterWordCounts } from '../../domain/book-node';
import { useWritingStatsStore } from '../../store/writing-stats-store';
import { useProseMetricsStatusStore } from '../../store/prose-metrics-status-store';
import { useBookNode } from '../../usecase/useBookNode';
import { useStoryline } from '../../usecase/useStoryline';
import { useBookElement } from '../../usecase/useBookElement';
import { useBookContent } from '../../usecase/useBookContent';
import { useElementCategory } from '../../usecase/useElementCategory';
import { useProjectAsset } from '../../usecase/useProjectAsset';
import { useLibraryItem } from '../../usecase/useLibraryItem';
import { useEntityRelations } from '../../usecase/useEntityRelations';
import { useEntityRelationTypes } from '../../usecase/useEntityRelationTypes';
import { useComment } from '../../usecase/useComment';
import { loadBookActs } from '../../usecase/useBookAct';
import { loadDriftGroups } from '../../usecase/useDriftGroup';
import { loadTimelineMarkers } from '../../hooks/useTimelineMarkers';
import { useProject } from '../../usecase/useProject';
import { rebuildProjectInlineReferenceIndex } from '../../services/reference-index.service';
import { reconcileProjectProseMetrics } from '../../services/node-prose-metrics.service';
import { flushPendingAtomicSyncTransactions } from '../../services/atomic-sync-transaction-tracker';
import { FullScreenStatus } from '../components/FullScreenStatus';

const log = loglevel.getLogger('ProjectRuntimeProvider');
log.setLevel(import.meta.env.DEV ? loglevel.levels.TRACE : loglevel.levels.WARN);

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
  const nodeUsecases = useBookNode({ projectId, userId });
  const storylineUsecases = useStoryline({ projectId, userId });
  const elementUsecases = useBookElement({ projectId, userId });
  const categoryUsecases = useElementCategory({ projectId, userId });
  const projectAssetUsecases = useProjectAsset({ projectId, userId });
  const libraryItemUsecases = useLibraryItem({ projectId, userId });
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
    setCommentKind: commentUsecases.setCommentKind,
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
      const nodes = useDataStore.getState().bookNodes;
      const total = sumCanonicalChapterWordCounts(nodes);
      if (total.ready) {
        useWritingStatsStore.getState().recordTotalWords(projectId, total.count);
      }
    };
    tick();
    const unsubscribeData = useDataStore.subscribe(tick);
    const unsubscribeStatus = useProseMetricsStatusStore.subscribe(tick);
    return () => {
      unsubscribeData();
      unsubscribeStatus();
    };
  }, [projectId]);

  useEffect(() => {
    if (bootState.key !== bootKey || bootState.status !== 'ready') return undefined;
    let disposed = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let refreshTail = Promise.resolve();

    const hydrateCommittedReplica = async () => {
      await flushPendingAtomicSyncTransactions();
      const project = await projectUsecases.loadProject(projectId);
      if (!project) {
        if (!disposed) setBootState({ key: bootKey, status: 'missing' });
        return;
      }
      await Promise.all([
        nodeUsecases.loadNodes(),
        storylineUsecases.loadStorylines(),
        elementUsecases.loadInitial(),
        categoryUsecases.loadCategories(),
        projectAssetUsecases.loadInitial(),
        libraryItemUsecases.loadInitial(),
        relationUsecases.loadInitial(),
        commentUsecases.loadInitial(),
        loadBookActs(projectId),
        loadDriftGroups(projectId),
        loadTimelineMarkers(projectId),
      ]);
      await storylineUsecases.loadNodeStorylineMapping();
      await rebuildProjectInlineReferenceIndex(projectId);
      await reconcileProjectProseMetrics(projectId);
    };

    const scheduleRefresh = (event: { projectId: string }) => {
      if (event.projectId !== projectId || disposed) return;
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        refreshTail = refreshTail
          .catch(() => undefined)
          .then(hydrateCommittedReplica)
          .catch((error) => log.warn('Remote project refresh failed:', error));
      }, 50);
    };

    events.on('sync:project-changed', scheduleRefresh);
    return () => {
      disposed = true;
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      events.off('sync:project-changed', scheduleRefresh);
    };
  }, [
    bootKey,
    bootState,
    categoryUsecases,
    commentUsecases,
    elementUsecases,
    libraryItemUsecases,
    nodeUsecases,
    projectAssetUsecases,
    projectId,
    projectUsecases,
    relationUsecases,
    storylineUsecases,
  ]);

  useEffect(() => {
    let active = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBootState({ key: bootKey, status: 'loading' });

    const initialize = async () => {
      try {
        await initDatabase(userId);
        const [project] = await Promise.all([
          projectUsecases.loadProject(projectId),
          nodeUsecases.loadNodes(),
          storylineUsecases.loadStorylines(),
          elementUsecases.loadInitial(),
          categoryUsecases.loadCategories(),
          projectAssetUsecases.loadInitial(),
          libraryItemUsecases.loadInitial(),
          relationUsecases.loadInitial(),
          commentUsecases.loadInitial(),
          loadBookActs(projectId),
          loadDriftGroups(projectId),
          loadTimelineMarkers(projectId),
        ]);
        await storylineUsecases.loadNodeStorylineMapping();
        await rebuildProjectInlineReferenceIndex(projectId).catch((error) => {
          log.warn('Reference index rebuild failed:', error);
        });

        if (!active) return;
        if (!project) {
          setBootState({ key: bootKey, status: 'missing' });
          return;
        }
        events.emit('db:ready');
        setBootState({ key: bootKey, status: 'ready' });
        // The project is already fully hydrated from its local SQLite replica.
        // Remote objects are ingested by SyncEngine and never overwrite the
        // local graph from a network response.
        void reconcileProjectProseMetrics(projectId).catch((error) => {
          log.warn('Canonical prose metric reconciliation failed:', error);
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error('Project initialization failed:', error);
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
  ]);

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

  return children;
}
