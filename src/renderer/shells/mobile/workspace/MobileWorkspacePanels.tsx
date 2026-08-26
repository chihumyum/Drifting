import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  CalendarRange,
  LibraryBig,
} from 'lucide-react';
import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';
import type { EntityKind } from '../../../lib/extensions/entity-link';
import { TodoPanel } from '../../../components/rightBars/TodoPanel';
import { LibraryPanel, type FocusedEntity } from '../../../features/library/LibraryPanel';
import { MobileAgentPanel } from './MobileAgentPanel';
import { MobilePanelPullHandle } from './MobilePanelPullHandle';
import type { MobilePanelGestureCommit } from './mobile-panel-gesture';
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
type ToolTab = 'planning' | 'agent' | 'library';
type PlanningMode = 'timeline' | 'plot';
type LibraryMode = 'todo' | 'library';
type PanelPosition = 'top' | 'bottom';

function focusedEntity(target: WorkspaceTarget | null): FocusedEntity {
  if (!target || target.entityType === 'all-chapters') {
    return { kind: null, id: null };
  }
  return { kind: target.entityType as EntityKind, id: target.id };
}

function MobileStructureWorkspace({
  target,
  extent,
  onExtentChange,
  onExtentCommit,
  onDragStateChange,
  onPreviewTarget,
}: {
  target: WorkspaceTarget | null;
  extent: number;
  onExtentChange: (extent: number) => void;
  onExtentCommit: (gesture: MobilePanelGestureCommit) => void;
  onDragStateChange: (panel: PanelPosition, dragging: boolean) => void;
  onPreviewTarget: (target: WorkspaceTarget) => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<StructureTab>('chapters');
  const structureTabs = [
    ['chapters', t('leftSidebar.tabs.chapters'), '§'],
    ['elements', t('leftSidebar.tabs.elements'), '◆'],
    ['inspiration', t('leftSidebar.tabs.drifts'), '❦'],
  ] as const;

  return (
    <section
      className="m-context-workspace m-context-workspace--structure"
      aria-label={t('leftSidebar.title')}
    >
      <div className="m-context-workspace__landscape">
        <aside className="m-context-tab-rail m-context-tab-rail--structure">
          <nav aria-label={t('leftSidebar.title')}>
            {structureTabs.map(([id, label, glyph]) => (
              <button
                key={id}
                type="button"
                aria-current={tab === id ? 'page' : undefined}
                aria-label={label}
                onClick={() => setTab(id)}
              >
                <span aria-hidden="true" style={{ fontSize: 17, lineHeight: 1 }}>{glyph}</span>
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
      <MobilePanelPullHandle
        panel="top"
        variant="boundary"
        extent={extent}
        onDragStateChange={onDragStateChange}
        onExtentChange={(_panel, nextExtent) => onExtentChange(nextExtent)}
        onExtentCommit={(_panel, gesture) => onExtentCommit(gesture)}
      />
    </section>
  );
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
  onDragStateChange,
}: {
  projectId: string;
  target: WorkspaceTarget | null;
  extent: number;
  onExtentChange: (extent: number) => void;
  onExtentCommit: (gesture: MobilePanelGestureCommit) => void;
  onDragStateChange: (panel: PanelPosition, dragging: boolean) => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<ToolTab>('planning');
  const [planningMode, setPlanningMode] = useState<PlanningMode>('timeline');
  const [libraryMode, setLibraryMode] = useState<LibraryMode>('todo');
  const focused = focusedEntity(target);
  const tabs = [
    ['planning', t('mobileWorkspace.planning', { defaultValue: '规划' }), CalendarRange],
    ['agent', 'Agent', Bot],
    ['library', t('rightSidebar.tabs.library'), LibraryBig],
  ] as const;

  return (
    <section
      className="m-context-workspace m-context-workspace--tools"
      aria-label={t('mobileWorkspace.tools', { defaultValue: '工具工作区' })}
    >
      <MobilePanelPullHandle
        panel="bottom"
        variant="boundary"
        extent={extent}
        onDragStateChange={onDragStateChange}
        onExtentChange={(_panel, nextExtent) => onExtentChange(nextExtent)}
        onExtentCommit={(_panel, gesture) => onExtentCommit(gesture)}
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
  onPanelDragStateChange,
  onPreviewTarget,
}: {
  projectId: string;
  target: WorkspaceTarget | null;
  panelExtent: number;
  onPanelExtentChange: (panel: PanelPosition, extent: number) => void;
  onPanelExtentCommit: (panel: PanelPosition, gesture: MobilePanelGestureCommit) => void;
  onPanelDragStateChange: (panel: PanelPosition, dragging: boolean) => void;
  onPreviewTarget: (target: WorkspaceTarget) => void;
}) {
  return (
    <>
      <MobileStructureWorkspace
        target={target}
        extent={panelExtent}
        onExtentChange={(extent) => onPanelExtentChange('top', extent)}
        onExtentCommit={(gesture) => onPanelExtentCommit('top', gesture)}
        onDragStateChange={onPanelDragStateChange}
        onPreviewTarget={onPreviewTarget}
      />
      <MobileToolWorkspace
        projectId={projectId}
        target={target}
        extent={panelExtent}
        onExtentChange={(extent) => onPanelExtentChange('bottom', extent)}
        onExtentCommit={(gesture) => onPanelExtentCommit('bottom', gesture)}
        onDragStateChange={onPanelDragStateChange}
      />
    </>
  );
}
