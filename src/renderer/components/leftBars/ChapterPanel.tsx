import { useState, useMemo, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import loglevel from 'loglevel';

import type { BookNode } from '../../domain/book-node';
import { CHAPTER_ORDER_STRIDE, isChapter } from '../../domain/book-node';
import { EntityCellContextMenu } from './EntityCellContextMenu';
import { GroupHeaderCell } from './GroupHeaderCell';
import { EntityHoverCard } from '../ui/EntityHoverCard';
import { useHoverPreview, type EntityHoverTarget } from '../ui/entity-hover-card-model';
import { AgentCountBadge } from './AgentCountBadge';
import { aggregateActivity } from './agentActivityBubble';
import { CollapsibleFooter } from '../ui/CollapsibleFooter';
import { useEntityCellAction } from '../../hooks/useEntityCellAction';
import { useDataStore } from '../../store/data-store';
import { useAgentActivityStore } from '../../store/agent-activity-store';
import { useAgentEditStore } from '../../store/agent-edit-store';
import { entityKey } from '../../lib/agent/tool-entity-ref';
import { useUiStore, usePromoteCurrentTab } from '../../store/ui-store';
import { useAuthStore } from '../../store/auth';
import { useBookNode } from '../../usecase/useBookNode';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { events } from '../../lib/events';

const log = loglevel.getLogger('ChapterPanel');
log.setLevel(loglevel.levels.ERROR);

// 宽度低于此值时隐藏 cell 右侧的 meta（日期/字数），优先保证 title 显示。
const META_HIDE_WIDTH = 200;

const formatShortDate =(input: string | number | Date) => {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const month = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return sameYear ? `${month}/${day}` : `${d.getFullYear() % 100}/${month}/${day}`;
};

// Compact word count for the narrow cell slot: raw under 1k, one-decimal k up
// to 10k, rounded k beyond (e.g. 0 / 521 / 1.2k / 12k).
const formatWordCount = (n: number) => {
  if (n < 1000) return `${n}`;
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
};

export function ChapterPanel() {
  const { t } = useTranslation();
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
  const cellMeta = useUiStore((s) => s.chapterCellMeta);
  const showMeta = sidebarWidth >= META_HIDE_WIDTH;
  // When on, a chapter linked to multiple storylines is listed only under its
  // primary storyline's group instead of duplicated across every group.
  const primaryOnly = useUiStore((s) => s.chapterStorylinePrimaryOnly);
  const userId = useAuthStore((state) => state.user?.id);
  const { projectId, openEntity } = useProjectNavigation();
  const promoteCurrentTab = usePromoteCurrentTab(projectId);
  const selectedNodeId = nodeUi.selectedId;
  // Agent activity: which nodes the agent is touching (pulse) / just changed (dot).
  const agentActive = useAgentActivityStore((s) => s.active);
  const agentTouched = useAgentActivityStore((s) => s.touched);
  // Persisted pending agent edits (approve/auto review) — survives reload, so a
  // chapter with unreviewed edits still shows "M" after a refresh.
  const agentPending = useAgentEditStore((s) => s.pending);
  const agentAdditions = useAgentEditStore((s) => s.additions);

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
        let primary = 0;
        if (mode === 'bookOrder') {
          primary = a.bookOrder - b.bookOrder;
        } else if (mode === 'narrativeOrder') {
          const av = a.narrativeOrder;
          const bv = b.narrativeOrder;
          if (av == null && bv == null) primary = 0;
          else if (av == null) primary = 1;
          else if (bv == null) primary = -1;
          else primary = av - bv;
        } else {
          const av = a[mode];
          const bv = b[mode];
          if (av === bv) primary = 0;
          else primary = bv > av ? 1 : -1; // desc for createdAt/updatedAt
        }
        if (primary !== 0) return primary;
        // Total-order tiebreak: when the primary key ties (e.g. several chapters
        // share a bookOrder, or both have null narrativeOrder) never fall back to
        // the input array's order — that order is the storylineNodeMapping
        // insertion order, which isn't guaranteed stable across rebuilds. id is
        // uuidv7 (≈ creation order), so this keeps the panel deterministic.
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
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
  // Drag-resize the unaffiliated footer's height while expanded. Persisted
  // in ui-store; null = use CollapsibleFooter's default height.
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
  // Hover summary card (same affordance as the element panel's).
  const {
    preview: hoverPreview,
    onEnter: hoverEnter,
    onLeave: hoverLeave,
  } = useHoverPreview<EntityHoverTarget>();

  const nodesByStoryline = useMemo(() => {
    const grouped: Record<string, BookNode[]> = {};
    const cmp = buildChapterComparator(storylineInnerSortMode);
    storylines.forEach((s) => {
      const ids = storylineNodeMapping[s.id] ?? [];
      grouped[s.id] = ids
        .map((id) => nodeById.get(id))
        .filter((n): n is BookNode => Boolean(n))
        .filter(isChapter)
        .filter(
          (n) => !primaryOnly || (primaryStorylineByNode[n.id] ?? null) === s.id,
        )
        .sort(cmp);
    });
    return grouped;
  }, [
    storylines,
    storylineNodeMapping,
    nodeById,
    storylineInnerSortMode,
    buildChapterComparator,
    primaryOnly,
    primaryStorylineByNode,
  ]);

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
    const agentAdded = !agentBusy && `node:${node.id}` in agentAdditions;
    const agentChanged =
      !agentBusy &&
      !agentAdded &&
      (`node:${node.id}` in agentTouched || `node:${node.id}` in agentPending);
    const primaryId = primaryStorylineByNode[node.id] ?? null;
    const storyline = primaryId ? storylineById.get(primaryId) : undefined;
    const stripeColor = storyline?.color ?? 'transparent';
    // Agent status rides the leading stripe while working — accent (lit) and
    // blinking. Once the run is done the stripe is swapped for a plain "M"
    // marker (below); at rest it keeps the storyline color.
    const stripeBg = agentBusy ? 'hsl(var(--accent))' : stripeColor;

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
          background: selected ? 'hsl(var(--surface))' : 'transparent',
          color: selected ? 'hsl(var(--ink-1))' : 'hsl(var(--ink-2))',
          fontSize: 12.5,
          lineHeight: 1.35,
          transition: 'background 0.1s',
        }}
        onMouseEnter={(event) => {
          if (!selected) {
            event.currentTarget.style.background = 'var(--workspace-cell-hover-bg)';
          }
          hoverEnter({ kind: 'node', id: node.id }, event.currentTarget);
        }}
        onMouseLeave={(event) => {
          if (!selected) {
            event.currentTarget.style.background = 'transparent';
          }
          hoverLeave();
        }}
        onClick={() => {
          hoverLeave();
          if (agentChanged) useAgentActivityStore.getState().clearTouched('node', node.id);
          openEntity({ entityType: 'node', id: node.id });
        }}
        onDoubleClick={() => {
          promoteCurrentTab();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          hoverLeave();
          setContextMenu({
            x: event.clientX,
            y: event.clientY,
            nodeId: node.id,
            nodeStatusKind: isChapter(node) ? 'chapter' : 'drift',
            nodeWritingStatus: node.writingStatus,
          });
        }}
      >
        {agentAdded || agentChanged ? (
          <span
            aria-hidden
            title={t(agentAdded ? 'agentActivity.addedHere' : 'agentActivity.changedHere')}
            style={{
              width: 12,
              flexShrink: 0,
              textAlign: 'center',
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              fontWeight: 600,
              lineHeight: 1,
              color: 'hsl(var(--ink-2))',
            }}
          >
            {agentAdded ? 'A' : 'M'}
          </span>
        ) : (
          <span
            aria-hidden
            className={agentBusy ? 'agent-glyph-busy' : undefined}
            title={agentBusy ? t('agentActivity.working') : undefined}
            style={{
              width: 12,
              height: 3,
              borderRadius: 1,
              background: stripeBg,
              flexShrink: 0,
            }}
          />
        )}

        <div
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
          <span>{node.title || t('common.untitled')}</span>
        </div>

        {showMeta && cellMeta !== 'none' && (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9.5,
              color: 'hsl(var(--ink-4))',
              flexShrink: 0,
              letterSpacing: '0.04em',
            }}
          >
            {cellMeta === 'wordCount'
              ? formatWordCount(node.wordCount)
              : cellMeta === 'both'
                ? `${formatWordCount(node.wordCount)} · ${formatShortDate(node.updatedAt)}`
                : formatShortDate(node.updatedAt)}
          </span>
        )}
      </div>
    );
  };

  const hasNodes = bookNodes.length > 0;
  const hasStorylines = storylines.length > 0;

  // Agent activity rolled up over the unaffiliated bucket — surfaced on the
  // footer header so changes hidden inside the (default-collapsed) drawer still
  // register (#17).
  const unaffiliatedActivity = aggregateActivity(
    agentActive,
    agentTouched,
    unaffiliatedChapters.map((n) => entityKey('node', n.id)),
  );

  return (
    <div
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
                fontFamily: 'var(--font-sans)',
                fontStyle: 'italic',
                color: 'hsl(var(--ink-3))',
                padding: '40px 20px',
                textAlign: 'center',
              }}
            >
              {t('leftSidebar.empty.noChapters')}
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
            // Bubble agent activity from this storyline's chapters up to its
            // group header (#17).
            const activity = aggregateActivity(
              agentActive,
              agentTouched,
              sNodes.map((n) => entityKey('node', n.id)),
            );
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
                  addButtonTitle={t('leftSidebar.groups.newChapterInStoryline')}
                  onAdd={() => void handleCreateNode(storyline.id)}
                  agentBusy={activity.busy}
                  agentDoneCount={activity.doneCount}
                  agentSelfChanged={
                    `storyline:${storyline.id}` in agentTouched ||
                    `storyline:${storyline.id}` in agentPending
                  }
                  agentSelfAdded={`storyline:${storyline.id}` in agentAdditions}
                />

                {!collapsed && sNodes.map((node) => renderNodeCard(node))}
              </div>
            );
          })}

          {!hasStorylines && (
            <div
              style={{
                fontSize: 12,
                fontFamily: 'var(--font-sans)',
                fontStyle: 'italic',
                color: 'hsl(var(--ink-3))',
                padding: '40px 20px',
                textAlign: 'center',
              }}
            >
              {t('leftSidebar.empty.noStorylines')}
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
        <CollapsibleFooter
          label={t('leftSidebar.groups.unaffiliated')}
          count={unaffiliatedChapters.length}
          headerExtra={
            !unaffiliatedActivity.busy && unaffiliatedActivity.doneCount > 0 ? (
              <AgentCountBadge
                count={unaffiliatedActivity.doneCount}
                title={t('agentActivity.unviewedChanges')}
              />
            ) : unaffiliatedActivity.busy ? (
              <span
                aria-hidden
                className="agent-glyph-busy"
                title={t('agentActivity.working')}
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 2,
                  background: 'hsl(var(--accent))',
                  flexShrink: 0,
                }}
              />
            ) : null
          }
          height={footerHeight}
          onHeightChange={setFooterHeight}
          expandTitle={t('leftSidebar.groups.expandUnaffiliated')}
          collapseTitle={t('leftSidebar.groups.collapseUnaffiliated')}
          bodyStyle={{ padding: '4px 0 12px' }}
        >
          {unaffiliatedChapters.length > 0 ? (
            unaffiliatedChapters.map((node) => renderNodeCard(node))
          ) : (
            <div
              style={{
                fontSize: 11.5,
                fontFamily: 'var(--font-sans)',
                fontStyle: 'italic',
                color: 'hsl(var(--ink-4))',
                padding: '16px 20px',
                textAlign: 'center',
              }}
            >
              {t('leftSidebar.empty.noUnaffiliatedChapters')}
            </div>
          )}
        </CollapsibleFooter>
      )}

      {hoverPreview && (
        <EntityHoverCard
          target={hoverPreview.data}
          anchor={hoverPreview.anchor}
          placement="right-start"
        />
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

    </div>
  );
}
