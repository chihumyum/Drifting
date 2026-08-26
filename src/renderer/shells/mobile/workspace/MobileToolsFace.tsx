import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';
import type { EntityKind } from '../../../lib/extensions/entity-link';
import { TodoPanel } from '../../../components/rightBars/TodoPanel';
import { LibraryPanel, type FocusedEntity } from '../../../features/library/LibraryPanel';
import { MobileAgentPanel } from './MobileAgentPanel';
import { PlotGridEditor } from '../../../components/editor/PlotGrid';
import {
  clonePlotGrid,
  diffPlotGrid,
  readPlotGridProjection,
  type PlotGrid,
  type PlotGridMutation,
} from '../../../domain/plot-grid';
import { useBookContent } from '../../../usecase/useBookContent';
import { useAuthStore } from '../../../store/auth';
import { BottomTimeline } from '../../../components/BottomTimeline/BottomTimeline';
import { useMobilePaperPresentation } from './MobilePaperContent';
import { usePaperGlyph } from './mobile-paper-glyph';

type ToolTab = 'planning' | 'agent' | 'library';
type PlanningMode = 'timeline' | 'plot';
type LibraryMode = 'todo' | 'library';

function focusedEntity(target: WorkspaceTarget | null): FocusedEntity {
  if (!target || target.entityType === 'all-chapters') {
    return { kind: null, id: null };
  }
  return { kind: target.entityType as EntityKind, id: target.id };
}

function MobilePlotPlannerWorkspace({
  projectId,
  target,
}: {
  projectId: string;
  target: WorkspaceTarget | null;
}) {
  const { t } = useTranslation();
  const userId = useAuthStore((state) => state.user?.id) ?? '';
  const { getContentByNodeId, updatePlotGridByNodeId } = useBookContent({ userId, projectId });
  const nodeId = target?.entityType === 'node' ? target.id : null;
  const [initialJson, setInitialJson] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInitialJson(null);
    if (!nodeId) return () => undefined;
    void getContentByNodeId(nodeId).then(
      (content) => {
        if (active) setInitialJson(content?.plotGridJson ?? '{}');
      },
      () => {
        if (active) setInitialJson('{}');
      },
    );
    return () => {
      active = false;
    };
  }, [getContentByNodeId, nodeId]);

  if (!nodeId) {
    return (
      <div className="m-tool-empty">
        {t('mobileWorkspace.plotNeedsNode', {
          defaultValue: '打开章节或灵感纸张后编辑情节网格。',
        })}
      </div>
    );
  }
  if (initialJson === null) {
    return <div className="m-tool-empty">{t('common.loading', { defaultValue: '加载中…' })}</div>;
  }
  return (
    <div className="m-plot-workspace">
      <MobileNormalizedPlotGridEditor
        key={nodeId}
        nodeId={nodeId}
        initialJson={initialJson}
        onPersist={updatePlotGridByNodeId}
      />
    </div>
  );
}

function MobileNormalizedPlotGridEditor({
  nodeId,
  initialJson,
  onPersist,
}: {
  nodeId: string;
  initialJson: string;
  onPersist: (nodeId: string, mutations: readonly PlotGridMutation[]) => Promise<unknown>;
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const committedGridRef = useRef<PlotGrid | null>(readPlotGridProjection(initialJson));
  const latestGridRef = useRef<PlotGrid | null>(null);
  const persistChainRef = useRef<Promise<void>>(Promise.resolve());
  const onPersistRef = useRef(onPersist);
  useEffect(() => {
    onPersistRef.current = onPersist;
  }, [onPersist]);

  const flush = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    if (!latestGridRef.current) return;
    const target = clonePlotGrid(latestGridRef.current);
    latestGridRef.current = null;
    persistChainRef.current = persistChainRef.current
      .then(async () => {
        const mutations = diffPlotGrid(committedGridRef.current, target);
        if (mutations.length > 0) await onPersistRef.current(nodeId, mutations);
        committedGridRef.current = target;
      })
      .catch((error) => {
        console.error('[PlotGrid] normalized mobile persistence failed:', error);
      });
  }, [nodeId]);

  useEffect(() => flush, [flush]);

  return (
    <PlotGridEditor
      initialJson={initialJson}
      onChange={(grid) => {
        latestGridRef.current = clonePlotGrid(grid);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(flush, 400);
      }}
    />
  );
}

/** The paper's full-screen tool face — the desktop right bar's home on
 * mobile, opened from the paper's top-right control. 规划/Agent/素材库 live
 * here as full-height panes; 统计/大纲/批注/操作/查找 hand off to their
 * existing sheets over the paper. */
export function MobileToolsFace({
  projectId,
  target,
  onClose,
  onOpenStats,
  onOpenSheet,
  onOpenSearch,
}: {
  projectId: string;
  target: WorkspaceTarget;
  onClose: () => void;
  onOpenStats: () => void;
  onOpenSheet: (sheet: 'outline' | 'comments' | 'actions') => void;
  onOpenSearch: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<ToolTab>('planning');
  const [planningMode, setPlanningMode] = useState<PlanningMode>('timeline');
  const [libraryMode, setLibraryMode] = useState<LibraryMode>('todo');
  const presentation = useMobilePaperPresentation(target);
  const glyph = usePaperGlyph(target);
  const focused = focusedEntity(target);
  const tabs = [
    ['planning', t('mobileWorkspace.planning', { defaultValue: '规划' })],
    ['agent', 'Agent'],
    ['library', t('rightSidebar.tabs.library')],
  ] as const;
  const handoffs = [
    [t('rightSidebar.tabs.stats', { defaultValue: '统计' }), onOpenStats],
    [t('mobileWorkspace.toolsFace.outline', { defaultValue: '大纲' }), () => onOpenSheet('outline')],
    [t('mobileWorkspace.toolsFace.comments', { defaultValue: '批注' }), () => onOpenSheet('comments')],
    [t('mobileWorkspace.search.open', { defaultValue: '搜索' }), onOpenSearch],
  ] as const;

  return (
    <section
      className="m-tools-face"
      role="dialog"
      aria-modal="true"
      data-debug-id="mobile-tools-face"
      aria-label={t('mobileWorkspace.tools', { defaultValue: '工具工作区' })}
    >
      <header className="m-tools-face__header">
        <span className="m-tools-face__identity">
          <span aria-hidden="true">{glyph}</span> {presentation.title}
        </span>
        <nav className="m-tools-face__tabs" aria-label={t('mobileWorkspace.tools', { defaultValue: '工具工作区' })}>
          {tabs.map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-current={tab === id ? 'page' : undefined}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <button
          type="button"
          className="m-tools-face__close"
          onClick={onClose}
          aria-label={t('findPanel.closeTitle')}
        >
          <X size={17} aria-hidden="true" />
        </button>
      </header>
      <div className="m-tools-face__handoffs">
        {handoffs.map(([label, run]) => (
          <button key={label} type="button" onClick={run}>
            {label}
          </button>
        ))}
      </div>
      <div className="m-tools-face__pane">
        {tab === 'planning' && (
          <>
            <header className="m-tool-workspace__subtabs">
              <button
                type="button"
                aria-current={planningMode === 'timeline' ? 'page' : undefined}
                onClick={() => setPlanningMode('timeline')}
              >
                {t('bottomTimeline.title', { defaultValue: '时间线' })}
              </button>
              <button
                type="button"
                aria-current={planningMode === 'plot' ? 'page' : undefined}
                onClick={() => setPlanningMode('plot')}
              >
                {t('editorTopBar.actions.plotPlanner', { defaultValue: '情节' })}
              </button>
            </header>
            <div className="m-context-workspace__pane m-context-workspace__body">
              {planningMode === 'timeline' ? (
                <div className="m-bottom-timeline">
                  <BottomTimeline presentation="mobile" />
                </div>
              ) : (
                <MobilePlotPlannerWorkspace
                  key={target.id}
                  projectId={projectId}
                  target={target}
                />
              )}
            </div>
          </>
        )}
        {tab === 'agent' && (
          <div className="m-context-workspace__pane m-context-workspace__body">
            <MobileAgentPanel projectId={projectId} target={target} />
          </div>
        )}
        {tab === 'library' && (
          <>
            <header className="m-tool-workspace__subtabs">
              <button
                type="button"
                aria-current={libraryMode === 'todo' ? 'page' : undefined}
                onClick={() => setLibraryMode('todo')}
              >
                TODO
              </button>
              <button
                type="button"
                aria-current={libraryMode === 'library' ? 'page' : undefined}
                onClick={() => setLibraryMode('library')}
              >
                {t('rightSidebar.tabs.library')}
              </button>
            </header>
            <div
              className="m-context-workspace__pane m-context-workspace__body m-library-workspace"
              data-mobile-library={libraryMode}
            >
              {libraryMode === 'todo' ? (
                <TodoPanel focused={focused} />
              ) : (
                <LibraryPanel focused={focused} presentation="mobile" />
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
