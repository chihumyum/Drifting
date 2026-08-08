import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  Bot,
  BookOpenText,
  ChartNoAxesColumn,
  Grid2X2,
  GripHorizontal,
  Library,
  ListTodo,
  Milestone,
  Rows3,
  Shapes,
  Sparkles,
  TableProperties,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';
import { useWorkspaceNavigator } from '../../../features/workspace/navigation/WorkspaceNavigationContext';
import { useDataStore } from '../../../store/data-store';
import { isChapter, isDrift } from '../../../domain/book-node';
import type { EntityKind } from '../../../lib/extensions/entity-link';
import { TodoPanel } from '../../../components/rightBars/TodoPanel';
import { LibraryPanel, type FocusedEntity } from '../../../features/library/LibraryPanel';
import { EntityStatsContent } from '../../../features/stats/EntityStatsContent';
import type { EntityStatsTarget } from '../../../features/stats/entity-stats-types';
import { CompanionPanel } from '../../../components/agent/CompanionPanel';
import { PlotGridEditor } from '../../../components/editor/PlotGrid';
import { serializePlotGrid, type PlotGrid } from '../../../domain/plot-grid';
import { useBookContent } from '../../../usecase/useBookContent';
import { useAuthStore } from '../../../store/auth';
import type { PaperReveal } from './usePaperPinch';

type StructureTab = 'chapters' | 'elements' | 'inspiration';
type ToolTab = 'todo' | 'library' | 'stats' | 'agent' | 'timeline' | 'plot';
type PanelPosition = Exclude<PaperReveal, 'focused'>;

function PanelResizeHandle({
  panel,
  full,
  onFullChange,
  onClose,
}: {
  panel: PanelPosition;
  full: boolean;
  onFullChange: (full: boolean) => void;
  onClose: () => void;
}) {
  const dragRef = useRef<{ y: number; moved: boolean } | null>(null);

  const finish = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.abs(dy) <= 5) {
      onFullChange(!full);
      return;
    }
    const expands = panel === 'top' ? dy > 40 : dy < -40;
    const contracts = panel === 'top' ? dy < -40 : dy > 40;
    if (expands) onFullChange(true);
    else if (contracts) {
      if (full) onFullChange(false);
      else onClose();
    }
  };

  return (
    <button
      type="button"
      className="m-context-workspace__handle"
      aria-label={full ? '收起面板' : '展开面板'}
      onPointerDown={(event) => {
        dragRef.current = { y: event.clientY, moved: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (drag && Math.abs(event.clientY - drag.y) > 5) drag.moved = true;
      }}
      onPointerUp={finish}
      onPointerCancel={() => {
        dragRef.current = null;
      }}
    >
      <GripHorizontal size={21} aria-hidden="true" />
    </button>
  );
}

function focusedEntity(target: WorkspaceTarget | null): FocusedEntity {
  if (!target || target.entityType === 'dashboard' || target.entityType === 'all-chapters') {
    return { kind: null, id: null };
  }
  return { kind: target.entityType as EntityKind, id: target.id };
}

function MobileStructureWorkspace({
  full,
  onFullChange,
  onClose,
  onPreviewTarget,
}: {
  full: boolean;
  onFullChange: (full: boolean) => void;
  onClose: () => void;
  onPreviewTarget: (target: WorkspaceTarget) => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<StructureTab>('chapters');
  const [elementView, setElementView] = useState<'grid' | 'shelf'>('grid');
  const {
    bookNodes,
    bookElements,
    bookElementCategories,
    storylines,
    primaryStorylineByNode,
    driftGroups,
  } = useDataStore();

  const chapters = useMemo(
    () =>
      bookNodes
        .filter(isChapter)
        .slice()
        .sort((a, b) => a.bookOrder - b.bookOrder),
    [bookNodes],
  );
  const inspiration = useMemo(
    () =>
      bookNodes
        .filter(isDrift)
        .slice()
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [bookNodes],
  );
  const categories = useMemo(() => {
    const grouped: Array<{
      category: (typeof bookElementCategories)[number] | null;
      elements: typeof bookElements;
    }> = bookElementCategories.map((category) => ({
      category,
      elements: bookElements.filter((element) => element.categoryId === category.id),
    }));
    const uncategorized = bookElements.filter((element) => element.categoryId === null);
    if (uncategorized.length > 0) grouped.push({ category: null, elements: uncategorized });
    return grouped;
  }, [bookElementCategories, bookElements]);
  const structureTabs = [
    ['chapters', BookOpenText, t('leftSidebar.tabs.chapters')],
    ['elements', Shapes, t('leftSidebar.tabs.elements')],
    ['inspiration', Sparkles, t('leftSidebar.tabs.drifts')],
  ] as const;

  return (
    <section
      className="m-context-workspace m-context-workspace--structure"
      aria-label={t('leftSidebar.title')}
    >
      <div className="m-context-workspace__landscape">
        <aside className="m-context-tab-rail">
          <div>
            <span>{t('mobileWorkspace.whereAmI', { defaultValue: '你在哪里' })}</span>
            <strong>{t('mobileWorkspace.structure', { defaultValue: '结构' })}</strong>
          </div>
          <nav aria-label={t('leftSidebar.title')}>
            {structureTabs.map(([id, Icon, label]) => (
              <button
                key={id}
                type="button"
                aria-label={label}
                aria-current={tab === id ? 'page' : undefined}
                onClick={() => setTab(id)}
              >
                <Icon size={17} aria-hidden="true" />
                <span>{label}</span>
              </button>
            ))}
          </nav>
        </aside>

        <div className="m-context-workspace__pane">
          {tab === 'chapters' && (
            <div className="m-structure-shelf" aria-label={t('leftSidebar.tabs.chapters')}>
              {chapters.map((node, index) => {
                const storyline = storylines.find(
                  (item) => item.id === primaryStorylineByNode[node.id],
                );
                return (
                  <button
                    key={node.id}
                    type="button"
                    onClick={() => onPreviewTarget({ entityType: 'node', id: node.id })}
                  >
                    <span>{String(index + 1).padStart(2, '0')}</span>
                    <strong>{node.title || t('common.untitled')}</strong>
                    <small>{storyline?.name ?? t('nodeEditor.empty.noStoryline')}</small>
                    <em>{node.wordCount.toLocaleString()} 字</em>
                  </button>
                );
              })}
            </div>
          )}

          {tab === 'elements' && (
            <>
              <div className="m-structure-view-toggle" role="group" aria-label="元素展示方式">
                <button
                  type="button"
                  aria-pressed={elementView === 'grid'}
                  onClick={() => setElementView('grid')}
                >
                  <Grid2X2 size={14} aria-hidden="true" />
                  分类网格
                </button>
                <button
                  type="button"
                  aria-pressed={elementView === 'shelf'}
                  onClick={() => setElementView('shelf')}
                >
                  <Rows3 size={14} aria-hidden="true" />
                  横向列表
                </button>
              </div>
              {elementView === 'grid' ? (
                <div className="m-structure-groups">
                  {categories.map(({ category, elements }) => (
                    <section key={category?.id ?? 'uncategorized'}>
                      <button
                        type="button"
                        disabled={!category}
                        onClick={() => {
                          if (category) {
                            onPreviewTarget({ entityType: 'category', id: category.id });
                          }
                        }}
                      >
                        <span style={{ background: category?.color || 'hsl(var(--ink-4))' }} />
                        <strong>{category?.name ?? '未分类'}</strong>
                        <small>{elements.length}</small>
                      </button>
                      <div>
                        {elements.map((element) => (
                          <button
                            key={element.id}
                            type="button"
                            onClick={() =>
                              onPreviewTarget({ entityType: 'element', id: element.id })
                            }
                          >
                            <strong>{element.name || t('common.untitled')}</strong>
                            <small>{element.summary || '还没有摘要'}</small>
                          </button>
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              ) : (
                <div className="m-structure-shelf m-structure-shelf--elements">
                  {bookElements.map((element) => {
                    const category = bookElementCategories.find(
                      (item) => item.id === element.categoryId,
                    );
                    return (
                      <button
                        key={element.id}
                        type="button"
                        onClick={() => onPreviewTarget({ entityType: 'element', id: element.id })}
                      >
                        <span style={{ background: category?.color || 'hsl(var(--ink-4))' }} />
                        <strong>{element.name || t('common.untitled')}</strong>
                        <small>{category?.name ?? '未分类'}</small>
                        <em>{element.summary || '还没有摘要'}</em>
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {tab === 'inspiration' && (
            <div className="m-structure-shelf" aria-label={t('leftSidebar.tabs.drifts')}>
              {inspiration.map((node) => {
                const group = driftGroups.find((item) => item.id === node.driftGroupId);
                return (
                  <button
                    key={node.id}
                    type="button"
                    onClick={() => onPreviewTarget({ entityType: 'node', id: node.id })}
                  >
                    <span>
                      <Sparkles size={13} aria-hidden="true" />
                    </span>
                    <strong>{node.title || t('common.untitled')}</strong>
                    <small>{group?.name ?? '未分组'}</small>
                    <em>{node.summary || '还没有摘要'}</em>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <PanelResizeHandle panel="top" full={full} onFullChange={onFullChange} onClose={onClose} />
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

function MobileTimelineWorkspace() {
  const { t } = useTranslation();
  const { open } = useWorkspaceNavigator();
  const { bookNodes, storylines, primaryStorylineByNode } = useDataStore();
  const [order, setOrder] = useState<'book' | 'narrative'>('book');
  const chapters = bookNodes
    .filter(isChapter)
    .slice()
    .sort((a, b) =>
      order === 'book'
        ? a.bookOrder - b.bookOrder
        : (a.narrativeOrder ?? a.bookOrder) - (b.narrativeOrder ?? b.bookOrder),
    );
  return (
    <div className="m-timeline-workspace">
      <header>
        <div role="group" aria-label={t('bottomTimeline.view.toggleTitle')}>
          <button type="button" aria-pressed={order === 'book'} onClick={() => setOrder('book')}>
            {t('bottomTimeline.view.book')}
          </button>
          <button
            type="button"
            aria-pressed={order === 'narrative'}
            onClick={() => setOrder('narrative')}
          >
            {t('bottomTimeline.view.narrative')}
          </button>
        </div>
        <span>{order === 'book' ? 'BOOK ORDER' : 'NARRATIVE ORDER'}</span>
      </header>
      {storylines.map((storyline) => (
        <section key={storyline.id}>
          <button type="button" onClick={() => open({ entityType: 'storyline', id: storyline.id })}>
            <span style={{ background: storyline.color || 'hsl(var(--ink-4))' }} />
            {storyline.name}
          </button>
          <div>
            {chapters
              .filter((node) => primaryStorylineByNode[node.id] === storyline.id)
              .map((node) => (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => open({ entityType: 'node', id: node.id })}
                >
                  {node.title || t('common.untitled')}
                </button>
              ))}
          </div>
        </section>
      ))}
    </div>
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
  const pendingRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    if (!nodeId || pendingRef.current === null) return;
    const serialized = pendingRef.current;
    pendingRef.current = null;
    void updatePlotGridByNodeId(nodeId, serialized);
  }, [nodeId, updatePlotGridByNodeId]);

  useEffect(() => flush, [flush]);

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
      <PlotGridEditor
        key={nodeId}
        initialJson={initialJson}
        onChange={(grid: PlotGrid) => {
          pendingRef.current = serializePlotGrid(grid);
          if (timerRef.current) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(flush, 400);
        }}
      />
    </div>
  );
}

function MobileToolWorkspace({
  projectId,
  target,
  full,
  onFullChange,
  onClose,
}: {
  projectId: string;
  target: WorkspaceTarget | null;
  full: boolean;
  onFullChange: (full: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<ToolTab>('todo');
  const focused = focusedEntity(target);
  const data = useDataStore();
  const currentStatsTarget = statsTarget(target);
  const tabs = [
    ['todo', ListTodo, 'TODO'],
    ['library', Library, t('rightSidebar.tabs.library')],
    ['stats', ChartNoAxesColumn, t('rightSidebar.tabs.stats')],
    ['agent', Bot, 'Agent'],
    ['timeline', Milestone, t('bottomTimeline.title', { defaultValue: '时间线' })],
    ['plot', TableProperties, t('editorTopBar.actions.plotPlanner', { defaultValue: '情节' })],
  ] as const;

  return (
    <section
      className="m-context-workspace m-context-workspace--tools"
      aria-label={t('mobileWorkspace.tools', { defaultValue: '工具工作区' })}
    >
      <PanelResizeHandle panel="bottom" full={full} onFullChange={onFullChange} onClose={onClose} />
      <div className="m-context-workspace__landscape">
        <aside className="m-context-tab-rail">
          <div>
            <span>{t('mobileWorkspace.whatCanIDo', { defaultValue: '你能做什么' })}</span>
            <strong>{t('mobileWorkspace.tools', { defaultValue: '工具' })}</strong>
          </div>
          <nav aria-label={t('mobileWorkspace.tools', { defaultValue: '工具工作区' })}>
            {tabs.map(([id, Icon, label]) => (
              <button
                key={id}
                type="button"
                aria-label={label}
                aria-current={tab === id ? 'page' : undefined}
                onClick={() => setTab(id)}
              >
                <Icon size={17} aria-hidden="true" />
                <span>{label}</span>
              </button>
            ))}
          </nav>
        </aside>
        <div className="m-context-workspace__pane m-context-workspace__body">
          {tab === 'todo' && <TodoPanel focused={focused} />}
          {tab === 'library' && <LibraryPanel focused={focused} />}
          {tab === 'stats' && (
            <div className="m-context-workspace__scroll m-context-workspace__stats">
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
          )}
          {tab === 'agent' && <CompanionPanel projectId={projectId} />}
          {tab === 'timeline' && <MobileTimelineWorkspace />}
          {tab === 'plot' && (
            <MobilePlotPlannerWorkspace
              key={target?.id ?? 'none'}
              projectId={projectId}
              target={target}
            />
          )}
        </div>
      </div>
    </section>
  );
}

export function MobileWorkspacePanels({
  projectId,
  target,
  fullPanel,
  onFullPanelChange,
  onClosePanel,
  onPreviewTarget,
}: {
  projectId: string;
  target: WorkspaceTarget | null;
  fullPanel: PanelPosition | null;
  onFullPanelChange: (panel: PanelPosition, full: boolean) => void;
  onClosePanel: () => void;
  onPreviewTarget: (target: WorkspaceTarget) => void;
}) {
  return (
    <>
      <MobileStructureWorkspace
        full={fullPanel === 'top'}
        onFullChange={(full) => onFullPanelChange('top', full)}
        onClose={onClosePanel}
        onPreviewTarget={onPreviewTarget}
      />
      <MobileToolWorkspace
        projectId={projectId}
        target={target}
        full={fullPanel === 'bottom'}
        onFullChange={(full) => onFullPanelChange('bottom', full)}
        onClose={onClosePanel}
      />
    </>
  );
}
