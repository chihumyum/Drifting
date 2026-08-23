import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  BarChart3,
  BookOpen,
  Bot,
  Boxes,
  CalendarRange,
  LibraryBig,
  Lightbulb,
} from 'lucide-react';
import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';
import { useDataStore } from '../../../store/data-store';
import { isDrift } from '../../../domain/book-node';
import type { EntityKind } from '../../../lib/extensions/entity-link';
import { TodoPanel } from '../../../components/rightBars/TodoPanel';
import { LibraryPanel, type FocusedEntity } from '../../../features/library/LibraryPanel';
import { EntityStatsContent } from '../../../features/stats/EntityStatsContent';
import type { EntityStatsTarget } from '../../../features/stats/entity-stats-types';
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
import { ChapterPanel } from '../../../components/leftBars/ChapterPanel';
import { ElementPanel } from '../../../components/leftBars/ElementPanel';
import { DriftPanel } from '../../../components/leftBars/DriftPanel';
import { BottomTimeline } from '../../../components/BottomTimeline/BottomTimeline';

type StructureTab = 'chapters' | 'elements' | 'inspiration';
type ToolTab = 'planning' | 'agent' | 'library' | 'stats';
type PlanningMode = 'timeline' | 'plot';
type LibraryMode = 'todo' | 'library';
type StatsMode = 'current' | 'book';
type PanelPosition = 'top' | 'bottom';

function PanelResizeHandle({
  panel,
  extent,
  onExtentChange,
  onExtentCommit,
}: {
  panel: PanelPosition;
  extent: number;
  onExtentChange: (extent: number) => void;
  onExtentCommit: (extent: number) => void;
}) {
  const dragRef = useRef<{ y: number; extent: number; latest: number } | null>(null);

  const extentForPointer = (clientY: number) => {
    const drag = dragRef.current;
    if (!drag) return extent;
    const direction = panel === 'top' ? 1 : -1;
    return Math.max(
      0,
      Math.min(1, drag.extent + (direction * (clientY - drag.y)) / window.innerHeight),
    );
  };

  const finish = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const next = extentForPointer(event.clientY);
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    onExtentCommit(next);
  };

  return (
    <button
      type="button"
      className="m-context-workspace__handle"
      aria-label={panel === 'top' ? '调整顶部面板高度' : '调整底部面板高度'}
      onPointerDown={(event) => {
        dragRef.current = { y: event.clientY, extent, latest: extent };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag) return;
        const next = extentForPointer(event.clientY);
        drag.latest = next;
        onExtentChange(next);
      }}
      onPointerUp={finish}
      onPointerCancel={() => {
        const drag = dragRef.current;
        dragRef.current = null;
        if (drag) onExtentCommit(drag.latest);
      }}
    />
  );
}

function focusedEntity(target: WorkspaceTarget | null): FocusedEntity {
  if (!target || target.entityType === 'dashboard' || target.entityType === 'all-chapters') {
    return { kind: null, id: null };
  }
  return { kind: target.entityType as EntityKind, id: target.id };
}

function MobileStructureWorkspace({
  target,
  extent,
  onExtentChange,
  onExtentCommit,
  onPreviewTarget,
}: {
  target: WorkspaceTarget | null;
  extent: number;
  onExtentChange: (extent: number) => void;
  onExtentCommit: (extent: number) => void;
  onPreviewTarget: (target: WorkspaceTarget) => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<StructureTab>('chapters');
  const structureTabs = [
    ['chapters', t('leftSidebar.tabs.chapters'), BookOpen],
    ['elements', t('leftSidebar.tabs.elements'), Boxes],
    ['inspiration', t('leftSidebar.tabs.drifts'), Lightbulb],
  ] as const;

  return (
    <section
      className="m-context-workspace m-context-workspace--structure"
      aria-label={t('leftSidebar.title')}
    >
      <div className="m-context-workspace__landscape">
        <aside className="m-context-tab-rail m-context-tab-rail--structure">
          <nav aria-label={t('leftSidebar.title')}>
            {structureTabs.map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                aria-current={tab === id ? 'page' : undefined}
                aria-label={label}
                onClick={() => setTab(id)}
              >
                <Icon size={19} aria-hidden="true" />
                <span>{label}</span>
              </button>
            ))}
          </nav>
        </aside>

        <div className="m-context-workspace__pane">
          {tab === 'chapters' && (
            <ChapterPanel
              presentation="mobile"
              activeTarget={target}
              onPreviewTarget={onPreviewTarget}
            />
          )}
          {tab === 'elements' && (
            <ElementPanel
              presentation="mobile"
              activeTarget={target}
              onPreviewTarget={onPreviewTarget}
            />
          )}
          {tab === 'inspiration' && (
            <DriftPanel
              presentation="mobile"
              activeTarget={target}
              onPreviewTarget={onPreviewTarget}
            />
          )}
        </div>
      </div>
      <PanelResizeHandle
        panel="top"
        extent={extent}
        onExtentChange={onExtentChange}
        onExtentCommit={onExtentCommit}
      />
    </section>
  );
}

function statsTarget(target: WorkspaceTarget | null): EntityStatsTarget {
  const data = useDataStore.getState();
  if (!target || target.entityType === 'dashboard') {
    return { kind: 'none', id: null, title: '—', kicker: '—' };
  }
  if (target.entityType === 'all-chapters') {
    return { kind: 'all-chapters', id: null, title: '通览全书', kicker: '全项目' };
  }
  if (target.entityType === 'node') {
    const node = data.bookNodes.find((item) => item.id === target.id);
    return {
      kind: node && isDrift(node) ? 'drift' : 'chapter',
      id: target.id,
      title: node?.title || '—',
      kicker: node && isDrift(node) ? '灵感' : '章节',
    };
  }
  if (target.entityType === 'storyline') {
    const storyline = data.storylines.find((item) => item.id === target.id);
    return {
      kind: 'storyline',
      id: target.id,
      title: storyline?.name || '—',
      kicker: '故事线',
      color: storyline?.color,
    };
  }
  if (target.entityType === 'element') {
    const element = data.bookElements.find((item) => item.id === target.id);
    return { kind: 'element', id: target.id, title: element?.name || '—', kicker: '元素' };
  }
  const category = data.bookElementCategories.find((item) => item.id === target.id);
  return {
    kind: 'category',
    id: target.id,
    title: category?.name || '—',
    kicker: '类目',
    color: category?.color,
  };
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

function MobileToolWorkspace({
  projectId,
  target,
  extent,
  onExtentChange,
  onExtentCommit,
}: {
  projectId: string;
  target: WorkspaceTarget | null;
  extent: number;
  onExtentChange: (extent: number) => void;
  onExtentCommit: (extent: number) => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<ToolTab>('planning');
  const [planningMode, setPlanningMode] = useState<PlanningMode>('timeline');
  const [libraryMode, setLibraryMode] = useState<LibraryMode>('todo');
  const [statsMode, setStatsMode] = useState<StatsMode>('current');
  const focused = focusedEntity(target);
  const data = useDataStore();
  const currentStatsTarget =
    statsMode === 'book'
      ? ({ kind: 'all-chapters', id: null, title: '通览全书', kicker: '全项目' } as const)
      : statsTarget(target);
  const tabs = [
    ['planning', t('mobileWorkspace.planning', { defaultValue: '规划' }), CalendarRange],
    ['agent', 'Agent', Bot],
    ['library', t('rightSidebar.tabs.library'), LibraryBig],
    ['stats', t('rightSidebar.tabs.stats'), BarChart3],
  ] as const;

  return (
    <section
      className="m-context-workspace m-context-workspace--tools"
      aria-label={t('mobileWorkspace.tools', { defaultValue: '工具工作区' })}
    >
      <PanelResizeHandle
        panel="bottom"
        extent={extent}
        onExtentChange={onExtentChange}
        onExtentCommit={onExtentCommit}
      />
      <div className="m-context-workspace__landscape m-tool-workspace">
        <aside className="m-context-tab-rail m-context-tab-rail--tools">
          <nav aria-label={t('mobileWorkspace.tools', { defaultValue: '工具工作区' })}>
            {tabs.map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                aria-current={tab === id ? 'page' : undefined}
                aria-label={label}
                onClick={() => setTab(id)}
              >
                <Icon size={19} aria-hidden="true" />
                <span>{label}</span>
              </button>
            ))}
          </nav>
        </aside>
        <div className="m-tool-workspace__pane">
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
                    key={target?.id ?? 'none'}
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
          {tab === 'stats' && (
            <>
              <header className="m-tool-workspace__subtabs m-stats-navigation">
                <button
                  type="button"
                  aria-current={statsMode === 'current' ? 'page' : undefined}
                  onClick={() => setStatsMode('current')}
                >
                  当前纸张
                </button>
                <button
                  type="button"
                  aria-current={statsMode === 'book' ? 'page' : undefined}
                  onClick={() => setStatsMode('book')}
                >
                  全书
                </button>
                <span title={currentStatsTarget.title}>{currentStatsTarget.title}</span>
              </header>
              <div
                className="m-context-workspace__pane m-context-workspace__scroll m-context-workspace__stats"
                data-mobile-stats={currentStatsTarget.kind === 'none' ? 'empty' : 'ready'}
              >
                <EntityStatsContent
                  target={currentStatsTarget}
                  bookNodes={data.bookNodes}
                  bookActs={data.bookActs}
                  bookElements={data.bookElements}
                  storylines={data.storylines}
                  categories={data.bookElementCategories}
                  storylineNodeMapping={data.storylineNodeMapping}
                  primaryStorylineByNode={data.primaryStorylineByNode}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

export function MobileWorkspacePanels({
  projectId,
  target,
  panelExtent,
  onPanelExtentChange,
  onPanelExtentCommit,
  onPreviewTarget,
}: {
  projectId: string;
  target: WorkspaceTarget | null;
  panelExtent: number;
  onPanelExtentChange: (panel: PanelPosition, extent: number) => void;
  onPanelExtentCommit: (panel: PanelPosition, extent: number) => void;
  onPreviewTarget: (target: WorkspaceTarget) => void;
}) {
  return (
    <>
      <MobileStructureWorkspace
        target={target}
        extent={panelExtent}
        onExtentChange={(extent) => onPanelExtentChange('top', extent)}
        onExtentCommit={(extent) => onPanelExtentCommit('top', extent)}
        onPreviewTarget={onPreviewTarget}
      />
      <MobileToolWorkspace
        projectId={projectId}
        target={target}
        extent={panelExtent}
        onExtentChange={(extent) => onPanelExtentChange('bottom', extent)}
        onExtentCommit={(extent) => onPanelExtentCommit('bottom', extent)}
      />
    </>
  );
}
