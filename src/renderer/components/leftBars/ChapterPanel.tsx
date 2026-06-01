import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { ChevronUp } from 'lucide-react';
import loglevel from 'loglevel';

import type { BookNode } from '../../domain/book-node';
import { CHAPTER_ORDER_STRIDE, isChapter } from '../../domain/book-node';
import { EntityCellContextMenu } from './EntityCellContextMenu';
import { GroupHeaderCell } from './GroupHeaderCell';
import { useEntityCellAction } from '../../hooks/useEntityCellAction';
import { useDataStore } from '../../store/data-store';
import { useAgentActivityStore } from '../../store/agent-activity-store';
import { useUiStore, usePromoteCurrentTab } from '../../store/ui-store';
import { useAuthStore } from '../../store/auth';
import { useBookNode } from '../../usecase/useBookNode';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { events } from '../../lib/events';

const log = loglevel.getLogger('ChapterPanel');
log.setLevel(loglevel.levels.ERROR);

// 宽度低于此值时隐藏 cell 上的日期，优先保证 title 显示。
const DATE_HIDE_WIDTH = 200;

const UNAFFILIATED_HEADER_HEIGHT = 28;
// Vertical drag-handle on the footer's top edge — sized for easy grabbing
// without visually intruding on the underlying border.
const FOOTER_RESIZE_HANDLE_HEIGHT = 6;

const formatShortDate = (input: string | number | Date) => {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const month = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return sameYear ? `${month}/${day}` : `${d.getFullYear() % 100}/${month}/${day}`;
};

export function ChapterPanel() {
  const { bookNodes, storylines, storylineNodeMapping, primaryStorylineByNode } = useDataStore();
  const { nodeUi } = useUiStore();
  const persistedViewMode = useUiStore((s) => s.chapterPanelViewMode);
  const globalSortMode = useUiStore((s) => s.chapterGlobalSortMode);
  const storylineInnerSortMode = useUiStore((s) => s.chapterStorylineInnerSortMode);
  // 0-storyline mode collapses to a single book-order view. Forcing it here
  // (rather than mutating the persisted setting) keeps the user's preference
  // intact for when they later add storylines.
  const viewMode = storylines.length === 0 ? 'global' : persistedViewMode;
  const sidebarWidth = useUiStore((s) => s.sidebars.left.width);
  const showDate = sidebarWidth >= DATE_HIDE_WIDTH;
  const userId = useAuthStore((state) => state.user?.id);
  const { projectId, openEntity } = useProjectNavigation();
  const promoteCurrentTab = usePromoteCurrentTab(projectId);
  const selectedNodeId = nodeUi.selectedId;
  // Agent activity: which nodes the agent is touching (pulse) / just changed (dot).
  const agentActive = useAgentActivityStore((s) => s.active);
  const agentTouched = useAgentActivityStore((s) => s.touched);

  const activeProjectId = useMemo(() => {
    if (!projectId) {
      throw new Error('ChapterPanel requires a non-empty projectId');
    }
    return projectId;
  }, [projectId]);

  const { createNode } = useBookNode({
    projectId: activeProjectId,
    userId: userId ?? '',
  });

  const [collapsedStorylineIds, setCollapsedStorylineIds] = useState<Set<string>>(new Set());

  const toggleStorylineCollapsed = useCallback((id: string) => {
    setCollapsedStorylineIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // Sub-header broadcasts a collapse-all request. Toggle between "all open"
  // and "all collapsed" based on current state.
  useEffect(() => {
    const handler = () => {
      setCollapsedStorylineIds((prev) => {
        if (prev.size === 0) {
          return new Set(storylines.map((s) => s.id));
        }
        return new Set();
      });
    };
    events.on('left-sidebar:collapse-all', handler);
    return () => events.off('left-sidebar:collapse-all', handler);
  }, [storylines]);

  const storylineById = useMemo(
    () => new Map(storylines.map((s) => [s.id, s])),
    [storylines],
  );
  const nodeById = useMemo(() => new Map(bookNodes.map((n) => [n.id, n])), [bookNodes]);

  // Comparator factory shared by global + storyline-inner sorting. Modes
  // common to both: bookOrder / narrativeOrder. Global view additionally
  // exposes createdAt / updatedAt. Null narrativeOrder sinks to the end so
  // partially-ordered books stay readable while the user wires up the rest.
  const buildChapterComparator = useCallback(
    (
      mode:
        | 'bookOrder'
        | 'narrativeOrder'
        | 'createdAt'
        | 'updatedAt',
    ) => {
      return (a: BookNode, b: BookNode) => {
        if (!isChapter(a) || !isChapter(b)) return 0;
        if (mode === 'bookOrder') return a.bookOrder - b.bookOrder;
        if (mode === 'narrativeOrder') {
          const av = a.narrativeOrder;
          const bv = b.narrativeOrder;
          if (av == null && bv == null) return 0;
          if (av == null) return 1;
          if (bv == null) return -1;
          return av - bv;
        }
        const av = a[mode];
        const bv = b[mode];
        if (av === bv) return 0;
        return bv > av ? 1 : -1; // desc for createdAt/updatedAt
      };
    },
    [],
  );

  const sortedNodesGlobal = useMemo(
    () =>
      bookNodes.filter(isChapter).slice().sort(buildChapterComparator(globalSortMode)),
    [bookNodes, globalSortMode, buildChapterComparator],
  );

  // Chapters in this project with no primary storyline — surfaced as the
  // "未归属" footer in storyline-grouping mode. Follows the storyline-inner
  // sort mode so the bucket feels like a sibling of the storyline lists
  // above it.
  const unaffiliatedChapters = useMemo(
    () =>
      bookNodes
        .filter(isChapter)
        .filter((n) => (primaryStorylineByNode[n.id] ?? null) == null)
        .sort(buildChapterComparator(storylineInnerSortMode)),
    [bookNodes, primaryStorylineByNode, storylineInnerSortMode, buildChapterComparator],
  );
  // Expanded state survives an empty bucket — the placeholder hint serves as
  // the content. (Auto-collapsing here caused a flash: click → expand → effect
  // fires because length is 0 → re-collapse.)
  const [unaffiliatedExpanded, setUnaffiliatedExpanded] = useState(false);
  // Drag-resize the unaffiliated footer's height while expanded. Persisted
  // in ui-store; null = use the default ratio of the panel.
  const footerHeight = useUiStore((s) => s.chapterUnaffiliatedFooterHeight);
  const setFooterHeight = useUiStore((s) => s.setChapterUnaffiliatedFooterHeight);
  // Per-cell context menu — reuses the editor top-bar three-dot menu items
  // via EntityCellContextMenu so the two surfaces stay in lockstep.
  const dispatchEntityAction = useEntityCellAction();
  const [contextMenu, setContextMenu] = useState<
    | {
        x: number;
        y: number;
        nodeId: string;
        nodeStatusKind: 'chapter' | 'drift';
        nodeWritingStatus: BookNode['writingStatus'];
      }
    | null
  >(null);
  const [storylineContextMenu, setStorylineContextMenu] = useState<
    | { x: number; y: number; storylineId: string }
    | null
  >(null);
  // Outer column ref — measure the available height for the drag clamp so the
  // footer can't grow past the panel itself.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isResizing, setIsResizing] = useState(false);

  const startFooterResize = useCallback(
    (event: React.MouseEvent) => {
      if (!containerRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      const startY = event.clientY;
      // Snapshot the panel's height at drag-start so the clamp doesn't
      // chase a layout that's mid-resize itself.
      const panelHeight = containerRef.current.getBoundingClientRect().height;
      const headerH = UNAFFILIATED_HEADER_HEIGHT;
      const startHeight =
        footerHeight ?? Math.max(headerH + 1, Math.round(panelHeight * 0.4));
      const min = headerH + 40;
      // Leave a small strip for the storyline list above; clamping to 90%
      // matches the feel of the ElementPanel footer drag.
      const max = Math.max(min, Math.round(panelHeight * 0.9));
      setIsResizing(true);
      const onMove = (ev: MouseEvent) => {
        const next = startHeight + (startY - ev.clientY);
        const clamped = Math.max(min, Math.min(max, next));
        setFooterHeight(clamped);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        setIsResizing(false);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
    },
    [footerHeight, setFooterHeight],
  );

  const nodesByStoryline = useMemo(() => {
    const grouped: Record<string, BookNode[]> = {};
    const cmp = buildChapterComparator(storylineInnerSortMode);
    storylines.forEach((s) => {
      const ids = storylineNodeMapping[s.id] ?? [];
      grouped[s.id] = ids
        .map((id) => nodeById.get(id))
        .filter((n): n is BookNode => Boolean(n))
        .filter(isChapter)
        .sort(cmp);
    });
    return grouped;
  }, [storylines, storylineNodeMapping, nodeById, storylineInnerSortMode, buildChapterComparator]);

  const handleCreateNode = useCallback(
    async (preferredStorylineId: string | null) => {
      try {
        // Caller-supplied storyline is the only signal. No fallback to
        // `storylines[0]` and no auto-create: when the caller doesn't pass a
        // storyline, the chapter lands 未归属 by design.
        const mainStorylineId = preferredStorylineId ?? null;

        const maxOrder = bookNodes
          .filter(isChapter)
          .reduce((max, n) => Math.max(max, n.bookOrder), 0);
        const nextOrder = maxOrder + CHAPTER_ORDER_STRIDE;

        const created = await createNode({
          kind: 'chapter',
          title: 'New Chapter',
          bookOrder: nextOrder,
          mainStorylineId,
        });
        openEntity({ entityType: 'node', id: created.id }, { preview: false });
      } catch (error) {
        log.error('Failed to create node', error);
      }
    },
    [bookNodes, createNode, openEntity],
  );

  // Cell layout: [storyline color stripe] [title] [date]. The stripe slot
  // is always rendered (so titles align) but goes transparent for
  // unaffiliated chapters per the "未归属 chapter 不加颜色" spec.
  const renderNodeCard = (node: BookNode) => {
    const selected = node.id === selectedNodeId;
    const agentBusy = `node:${node.id}` in agentActive;
    const agentChanged = !agentBusy && `node:${node.id}` in agentTouched;
    const primaryId = primaryStorylineByNode[node.id] ?? null;
    const storyline = primaryId ? storylineById.get(primaryId) : undefined;
    const stripeColor = storyline?.color ?? 'transparent';

    return (
      <div
        key={node.id}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '5px 14px 5px 22px',
          cursor: 'pointer',
          position: 'relative',
          background: selected ? 'hsl(var(--accent) / 0.10)' : 'transparent',
          color: selected ? 'hsl(var(--ink-1))' : 'hsl(var(--ink-2))',
          fontSize: 12.5,
          lineHeight: 1.35,
          transition: 'background 0.1s',
        }}
        onMouseEnter={(event) => {
          if (!selected) {
            event.currentTarget.style.background = 'hsl(var(--ink-1) / 0.03)';
          }
        }}
        onMouseLeave={(event) => {
          if (!selected) {
            event.currentTarget.style.background = 'transparent';
          }
        }}
        onClick={() => {
          if (agentChanged) useAgentActivityStore.getState().clearTouched('node', node.id);
          openEntity({ entityType: 'node', id: node.id });
        }}
        onDoubleClick={() => {
          promoteCurrentTab();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setContextMenu({
            x: event.clientX,
            y: event.clientY,
            nodeId: node.id,
            nodeStatusKind: isChapter(node) ? 'chapter' : 'drift',
            nodeWritingStatus: node.writingStatus,
          });
        }}
      >
        {selected && (
          <span
            aria-hidden
            className="cell-accent-stripe"
            style={{
              position: 'absolute',
              left: 0,
              top: 4,
              bottom: 4,
              width: 2,
              background: 'hsl(var(--accent))',
            }}
          />
        )}

        <span
          aria-hidden
          style={{
            width: 12,
            height: 3,
            borderRadius: 1,
            background: stripeColor,
            flexShrink: 0,
          }}
        />

        <div
          className={agentChanged ? 'agent-name-done' : undefined}
          title={agentChanged ? 'Agent 刚改动了这里' : undefined}
          style={{
            flex: 1,
            minWidth: 0,
            color: 'inherit',
            fontWeight: selected ? 500 : 400,
            letterSpacing: '-0.005em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          <span>{node.title || 'Untitled'}</span>
        </div>

        {showDate && (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9.5,
              color: 'hsl(var(--ink-4))',
              flexShrink: 0,
              letterSpacing: '0.04em',
            }}
          >
            {formatShortDate(node.updatedAt)}
          </span>
        )}

        {agentBusy && <span aria-hidden className="agent-busy-line" title="Agent 正在处理" />}
      </div>
    );
  };

  const hasNodes = bookNodes.length > 0;
  const hasStorylines = storylines.length > 0;

  return (
    <div
      ref={containerRef}
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <div
        className="left-panel-scroll-hidden"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '6px 0 24px',
        }}
      >
      {viewMode === 'global' && (
        <>
          {sortedNodesGlobal.map((node) => renderNodeCard(node))}
          {!hasNodes && (
            <div
              style={{
                fontSize: 12,
                fontFamily: 'var(--font-serif)',
                fontStyle: 'italic',
                color: 'hsl(var(--ink-3))',
                padding: '40px 20px',
                textAlign: 'center',
              }}
            >
              no chapters yet.
            </div>
          )}
        </>
      )}

      {viewMode === 'storyline' && (
        <>
          {storylines.map((storyline) => {
            const sNodes = nodesByStoryline[storyline.id] ?? [];
            const collapsed = collapsedStorylineIds.has(storyline.id);
            const color = storyline.color || 'hsl(var(--ink-4))';
            return (
              <div
                key={storyline.id}
                className="left-sb-group"
                style={{ marginBottom: 10 }}
              >
                <GroupHeaderCell
                  name={storyline.name}
                  count={sNodes.length}
                  color={color}
                  collapsed={collapsed}
                  onToggleCollapsed={() => toggleStorylineCollapsed(storyline.id)}
                  onClick={() => openEntity({ entityType: 'storyline', id: storyline.id })}
                  onDoubleClick={() => promoteCurrentTab()}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setStorylineContextMenu({
                      x: event.clientX,
                      y: event.clientY,
                      storylineId: storyline.id,
                    });
                  }}
                  addButtonTitle="New chapter in this storyline"
                  onAdd={() => void handleCreateNode(storyline.id)}
                />

                {!collapsed && sNodes.map((node) => renderNodeCard(node))}
              </div>
            );
          })}

          {!hasStorylines && (
            <div
              style={{
                fontSize: 12,
                fontFamily: 'var(--font-serif)',
                fontStyle: 'italic',
                color: 'hsl(var(--ink-3))',
                padding: '40px 20px',
                textAlign: 'center',
              }}
            >
              no storylines yet.
            </div>
          )}
        </>
      )}
      </div>

      {/* Unaffiliated footer — only in storyline-grouping mode. Always visible
          (parallels DriftPanel's resting footer), default collapsed; expanding
          lists the chapters without a primary storyline. The top edge is a
          drag handle when expanded so the user can pull the footer up to claim
          more of the panel for the unaffiliated bucket. */}
      {viewMode === 'storyline' && (
        <div
          style={{
            borderTop: '1px solid hsl(var(--rule))',
            background: 'hsl(var(--paper-deep) / 0.5)',
            display: 'flex',
            flexDirection: 'column',
            flexShrink: 0,
            // Collapsed: just the header strip. Expanded: persisted height
            // (or 40% default). The transition only fires on the expand/
            // collapse toggle — during a live drag the height updates on
            // every move, so we drop the transition to avoid lag.
            height: unaffiliatedExpanded
              ? footerHeight ?? '40%'
              : UNAFFILIATED_HEADER_HEIGHT,
            transition: isResizing ? 'none' : 'height 0.18s ease',
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          {unaffiliatedExpanded && (
            <div
              onMouseDown={startFooterResize}
              title="拖动调整未归属高度"
              style={{
                position: 'absolute',
                top: -FOOTER_RESIZE_HANDLE_HEIGHT / 2,
                left: 0,
                right: 0,
                height: FOOTER_RESIZE_HANDLE_HEIGHT,
                cursor: 'ns-resize',
                zIndex: 5,
              }}
            />
          )}
          <button
            type="button"
            onClick={() => setUnaffiliatedExpanded((v) => !v)}
            style={{
              all: 'unset',
              boxSizing: 'border-box',
              height: UNAFFILIATED_HEADER_HEIGHT,
              padding: '0 14px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              cursor: 'pointer',
              fontSize: 11,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'hsl(var(--ink-3))',
              fontFamily: 'var(--font-mono)',
              flexShrink: 0,
            }}
            aria-expanded={unaffiliatedExpanded}
            title={unaffiliatedExpanded ? '收起未归属' : '展开未归属'}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>未归属</span>
              <span style={{ color: 'hsl(var(--ink-4))' }}>
                {unaffiliatedChapters.length}
              </span>
            </span>
            <ChevronUp
              size={12}
              style={{
                transform: unaffiliatedExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                transition: 'transform 0.18s ease',
              }}
            />
          </button>
          {unaffiliatedExpanded && (
            <div
              className="left-panel-scroll-hidden"
              style={{
                flex: 1,
                minHeight: 0,
                overflowY: 'auto',
                padding: '4px 0 12px',
              }}
            >
              {unaffiliatedChapters.length > 0 ? (
                unaffiliatedChapters.map((node) => renderNodeCard(node))
              ) : (
                <div
                  style={{
                    fontSize: 11.5,
                    fontFamily: 'var(--font-serif)',
                    fontStyle: 'italic',
                    color: 'hsl(var(--ink-4))',
                    padding: '16px 20px',
                    textAlign: 'center',
                  }}
                >
                  no unaffiliated chapters.
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {contextMenu && (
        <EntityCellContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          editorType="node"
          nodeStatusKind={contextMenu.nodeStatusKind}
          nodeWritingStatus={contextMenu.nodeWritingStatus}
          onAction={(action) => {
            void dispatchEntityAction({
              entityType: 'node',
              id: contextMenu.nodeId,
              action,
            });
          }}
          onClose={() => setContextMenu(null)}
        />
      )}

      {storylineContextMenu && (
        <EntityCellContextMenu
          x={storylineContextMenu.x}
          y={storylineContextMenu.y}
          editorType="storyline"
          onAction={(action) => {
            void dispatchEntityAction({
              entityType: 'storyline',
              id: storylineContextMenu.storylineId,
              action,
            });
          }}
          onClose={() => setStorylineContextMenu(null)}
        />
      )}

      {/* Reveal the per-group + button on hover (no extra chrome at rest). */}
      <style>{`
        .left-sb-group-add { opacity: 0; }
        .left-sb-group:hover .left-sb-group-add { opacity: 1; }
        .left-panel-scroll-hidden { scrollbar-width: none; }
        .left-panel-scroll-hidden::-webkit-scrollbar { width: 0; height: 0; display: none; }
      `}</style>
    </div>
  );
}
