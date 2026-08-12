import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import loglevel from 'loglevel';
import { initDatabase } from '../../lib/db';
import { events } from '../../lib/events';
import { useAgentToolBridge } from '../../lib/agent/useAgentToolBridge';
import { useDriftingAgentRuntime } from '../../lib/agent/useDriftingAgentRuntime';
import { useDataStore } from '../../store/data-store';
import { useWritingStatsStore } from '../../store/writing-stats-store';
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
import { startPreferencesSync } from '../../services/preferences-sync.service';
import { startSyncObserver } from '../../services/sync-observer.service';
import { pullAndHydrateProjectGraph } from '../../services/entity-sync.service';
import { rebuildProjectInlineReferenceIndex } from '../../services/reference-index.service';
import { resumeProjectAssetUploads } from '../../services/durable-asset-upload.service';
import { FullScreenStatus } from '../components/FullScreenStatus';

const log = loglevel.getLogger('ProjectRuntimeProvider');
log.setLevel(import.meta.env.DEV ? loglevel.levels.TRACE : loglevel.levels.WARN);

type ProjectBootState =
  | { key: string; status: 'loading' }
  | { key: string; status: 'ready' }
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
    updateRelationKind: relationUsecases.updateRelationKind,
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
      const nodes = useDataStore.getState().bookNodes;
      const total = nodes.reduce((sum, node) => sum + (node.wordCount || 0), 0);
      useWritingStatsStore.getState().recordTotalWords(projectId, total);
    };
    tick();
    return useDataStore.subscribe(tick);
  }, [projectId]);

  useEffect(() => {
    startSyncObserver();
  }, []);

  useEffect(() => {
    const resumeUploads = () => {
      void resumeProjectAssetUploads(projectId).catch((error) => {
        log.warn('Durable asset upload resume failed:', error);
      });
    };
    window.addEventListener('online', resumeUploads);
    return () => window.removeEventListener('online', resumeUploads);
  }, [projectId]);

  useEffect(() => {
    let active = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBootState({ key: bootKey, status: 'loading' });

    const initialize = async () => {
      try {
        await initDatabase(userId);
        await Promise.all([
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
        events.emit('db:ready');
        setBootState({ key: bootKey, status: 'ready' });
        void pullAndHydrateProjectGraph(projectId)
          .catch((error) => log.warn('Project graph hydrate failed:', error))
          .finally(() => {
            if (!active) return;
            void resumeProjectAssetUploads(projectId).catch((error) => {
              log.warn('Durable asset upload resume failed:', error);
            });
          });
        void startPreferencesSync().catch((error) => {
          log.warn('Preferences sync init failed:', error);
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
