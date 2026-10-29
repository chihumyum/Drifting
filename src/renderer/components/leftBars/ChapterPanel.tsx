import { useAgentUnreadMarks } from '../../hooks/useAgentUnreadMarks';
import { AgentChangeIndicator } from './AgentChangeIndicator';
import { useSidebarPreference, useSidebarPanelState, useSidebarSelection, useSidebarPanelScroll } from '../../hooks/useSidebarPanelState';
import { useSidebarPaneId } from '../../lib/sidebar-pane-context';
import { useLeftSidebarPanelWidth } from '../../hooks/useLeftSidebarPanelWidth';
import { useMemo, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import loglevel from 'loglevel';

import type { BookNode } from '../../domain/book-node';
import { canonicalWordCount, CHAPTER_ORDER_STRIDE, isChapter } from '../../domain/book-node';
import { entityHoverActions } from './entity-hover-actions';
import { GroupHeaderCell } from './GroupHeaderCell';
import { KindMark } from '../ui/KindMark';
import { CELL_PAD_LEFT, SandCell } from '../ui/SandCell';
import { EntityHoverCard } from '../../features/entities/hover/EntityHoverCard';
import {
  useHoverPreview,
  type EntityHoverTarget,
} from '../../features/entities/hover/entity-hover-card-model';
import { aggregateActivity } from './agentActivityBubble';
import { useEntityCellAction } from '../../hooks/useEntityCellAction';
import { useDataStoreFields } from '../../store/use-data-store-fields';
import { useAgentActivityStore } from '../../store/agent-activity-store';
import { useAgentEditStore } from '../../store/agent-edit-store';
import { entityKey } from '../../lib/agent/tool-entity-ref';
import { useUiStore, usePromoteCurrentTab } from '../../store/ui-store';
import { useAuthStore } from '../../store/auth';
import { useBookNode } from '../../usecase/useBookNode';
import { useSidebarPanelNavigation as useProjectNavigation } from '../../hooks/useSidebarPanelNavigation';
import { subscribeSidebarCollapse } from '../../lib/sidebar-pane-events';
import type { WorkspaceTarget } from '../../features/workspace/navigation/workspace-target';
import { BrushIcon } from '../ui/BrushIcon';

const log = loglevel.getLogger('ChapterPanel');
log.setLevel(loglevel.levels.ERROR);

// Synthetic id used only by the local collapse model. The unaffiliated bucket
// is rendered as the final storyline-style group, but it is not a persisted
// Storyline entity and must never be sent to storyline use cases.
const UNAFFILIATED_GROUP_ID = '__unaffiliated__';
// Match the synthetic group's chapter labels to the neutral ink-4 marker used
// by its group header in both light and dark themes.
const UNAFFILIATED_STRIPE_COLOR = 'hsl(var(--ink-4))';

// 宽度低于此值时隐藏 cell 右侧的 meta（日期/字数），优先保证 title 显示。
const META_HIDE_WIDTH = 200;

const formatShortDate = (input: string | number | Date) => {
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

interface ChapterPanelProps {
  presentation?: 'desktop' | 'mobile';
  activeTarget?: WorkspaceTarget | null;
  onPreviewTarget?: (target: WorkspaceTarget) => void;
}

export function ChapterPanel({
  presentation = 'desktop',
  activeTarget = null,
  onPreviewTarget,
}: ChapterPanelProps = {}) {
  const { t } = useTranslation();
  const { bookNodes, storylines, storylineNodeMapping, primaryStorylineByNode } = useDataStoreFields('bookNodes', 'storylines', 'storylineNodeMapping', 'primaryStorylineByNode');
  const { nodeUi } = useUiStore();
  const [persistedViewMode] = useSidebarPreference('chapterPanelViewMode');
  const [globalSortMode] = useSidebarPreference('chapterGlobalSortMode');
  const [storylineInnerSortMode] = useSidebarPreference('chapterStorylineInnerSortMode');
  const [storylineOuterSortMode] = useSidebarPreference('chapterStorylineOuterSortMode');
  // 0-storyline mode collapses to a single book-order view. Forcing it here
  // (rather than mutating the persisted setting) keeps the user's preference
  // intact for when they later add storylines.
  const viewMode = storylines.length === 0 ? 'global' : persistedViewMode;
  const sidebarWidth = useLeftSidebarPanelWidth();
  const paneId = useSidebarPaneId();
  const [cellMeta] = useSidebarPreference('chapterCellMeta');
  const showMeta = presentation === 'desktop' && sidebarWidth >= META_HIDE_WIDTH;
  // When on, a chapter linked to multiple storylines is listed only under its
  // primary storyline's group instead of duplicated across every group.
  const [primaryOnly] = useSidebarPreference('chapterStorylinePrimaryOnly');
  const userId = useAuthStore((state) => state.user?.id);
  const { projectId, openEntity } = useProjectNavigation();
  const promoteCurrentTab = usePromoteCurrentTab(projectId);
  const fallbackSelectedId = presentation === 'mobile' && activeTarget?.entityType === 'node'
      ? activeTarget.id
      : nodeUi.selectedId;
  const [selection] = useSidebarSelection(fallbackSelectedId ? { entityType: 'node', id: fallbackSelectedId } : null);
  const selectedNodeId = selection?.entityType === 'node' ? selection.id : null;
  const selectedStorylineId = selection?.entityType === 'storyline' ? selection.id : null;
  const scroll = useSidebarPanelScroll();
  const activateTarget = useCallback(
    (target: WorkspaceTarget, options?: { preview?: boolean }) => {
      if (onPreviewTarget && options?.preview !== false) onPreviewTarget(target);
      else openEntity(target, options);
    },
    [onPreviewTarget, openEntity],
  );
  // Agent activity: which nodes the agent is touching (pulse) / just changed (dot).
  const agentActive = useAgentActivityStore((s) => s.active);
  const agentTouched = useAgentUnreadMarks();
  // Persisted pending agent edits (approve/auto review) — survives reload, so a
  // chapter with unreviewed edits still shows "M" after a refresh.
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

  const [collapsedGroupIds, setCollapsedGroupIds] = useSidebarPanelState<Set<string>>('collapsed', () => new Set());

  const toggleGroupCollapsed = useCallback((id: string) => {
    setCollapsedGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, [setCollapsedGroupIds]);

  // Sub-header broadcasts a collapse-all request. Toggle between "all open"
  // and "all collapsed" based on current state.
  useEffect(() => {
    const handler = () => {
      setCollapsedGroupIds((prev) => {
        if (prev.size === 0) {
          return new Set([...storylines.map((s) => s.id), UNAFFILIATED_GROUP_ID]);
        }
        return new Set();
      });
    };
    return subscribeSidebarCollapse('nodes', paneId, handler);
  }, [storylines, paneId, setCollapsedGroupIds]);

  const storylineById = useMemo(() => new Map(storylines.map((s) => [s.id, s])), [storylines]);
  const sortedStorylines = useMemo(
    () =>
      storylines.slice().sort((a, b) => {
        if (storylineOuterSortMode === 'alphabet') {
          const byName = a.name.localeCompare(b.name, undefined, {
            numeric: true,
            sensitivity: 'base',
          });
          if (byName !== 0) return byName;
        }
        const byStorylineOrder = a.orderKey - b.orderKey;
        if (byStorylineOrder !== 0) return byStorylineOrder;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      }),
    [storylines, storylineOuterSortMode],
  );
  const nodeById = useMemo(() => new Map(bookNodes.map((n) => [n.id, n])), [bookNodes]);

  // Comparator factory shared by global + storyline-inner sorting. Modes
  // common to both: bookOrder / narrativeOrder. Global view additionally
  // exposes createdAt / updatedAt. Null narrativeOrder sinks to the end so
  // partially-ordered books stay readable while the user wires up the rest.
  const buildChapterComparator = useCallback(
    (mode: 'bookOrder' | 'narrativeOrder' | 'createdAt' | 'updatedAt') => {
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
    () => bookNodes.filter(isChapter).slice().sort(buildChapterComparator(globalSortMode)),
    [bookNodes, globalSortMode, buildChapterComparator],
  );

  // Chapters in this project with no primary storyline. The bucket follows
  // the storyline-inner sort mode and is rendered as the final sibling group
  // after every real storyline.
  const unaffiliatedChapters = useMemo(
    () =>
      bookNodes
        .filter(isChapter)
        .filter((n) => (primaryStorylineByNode[n.id] ?? null) == null)
        .sort(buildChapterComparator(storylineInnerSortMode)),
    [bookNodes, primaryStorylineByNode, storylineInnerSortMode, buildChapterComparator],
  );
  // Hover card: the summary, and along its bottom the same actions as the
  // editor's ⋯ menu (entityHoverActions). There are no right-click menus.
  const dispatchEntityAction = useEntityCellAction();
  const {
    preview: hoverPreview,
    onEnter: hoverEnter,
    onLeave: hoverLeave,
    dismiss: hoverDismiss,
    card: hoverCard,
  } = useHoverPreview<EntityHoverTarget>();
  const hoverActionsFor = (target: EntityHoverTarget) => {
    if (target.kind === 'storyline') {
      return entityHoverActions({
        editorType: 'storyline',
        onAction: (action) => void dispatchEntityAction({ entityType: 'storyline', id: target.id, action }),
        t,
      });
    }
    const node = target.kind === 'node' ? nodeById.get(target.id) : undefined;
    if (!node) return undefined;
    return entityHoverActions({
      editorType: 'node',
      nodeStatusKind: isChapter(node) ? 'chapter' : 'drift',
      nodeWritingStatus: node.writingStatus,
      onAction: (action) => void dispatchEntityAction({ entityType: 'node', id: node.id, action }),
      t,
    });
  };

  const nodesByStoryline = useMemo(() => {
    const grouped: Record<string, BookNode[]> = {};
    const cmp = buildChapterComparator(storylineInnerSortMode);
    storylines.forEach((s) => {
      const ids = storylineNodeMapping[s.id] ?? [];
      grouped[s.id] = ids
        .map((id) => nodeById.get(id))
        .filter((n): n is BookNode => Boolean(n))
        .filter(isChapter)
        .filter((n) => !primaryOnly || (primaryStorylineByNode[n.id] ?? null) === s.id)
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
        activateTarget({ entityType: 'node', id: created.id }, { preview: false });
      } catch (error) {
        log.error('Failed to create node', error);
      }
    },
    [activateTarget, bookNodes, createNode],
  );

  // Cell layout: [chapter seal] [title] [date]. The seal is pressed in the
  // primary storyline's colour; unaffiliated chapters use a quiet neutral
  // gray instead of disappearing.
  const renderNodeCard = (node: BookNode) => {
    const selected = node.id === selectedNodeId;
    const agentBusy = `node:${node.id}` in agentActive;
    const agentAdded = !agentBusy && `node:${node.id}` in agentAdditions;
    const agentChanged =
      !agentBusy &&
      !agentAdded &&
      (`node:${node.id}` in agentTouched);
    const primaryId = primaryStorylineByNode[node.id] ?? null;
    const storyline = primaryId ? storylineById.get(primaryId) : undefined;
    const stripeColor = storyline?.color ?? UNAFFILIATED_STRIPE_COLOR;
    const exactWordCount = canonicalWordCount(node);
    const wordCountLabel =
      exactWordCount == null ? t('common.counting') : formatWordCount(exactWordCount);

    return (
      <SandCell
        key={node.id}
        selected={selected}
        color={stripeColor}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          margin: '0 6px',
          padding: `5px 10px 5px ${CELL_PAD_LEFT}px`,
          borderRadius: 3,
          cursor: 'pointer',
          color: selected ? 'hsl(var(--ink-1))' : 'hsl(var(--ink-2))',
          fontSize: 'var(--ui-font-body, 12.5px)',
          lineHeight: 'var(--ui-line-body, 1.35)',
          minHeight: 'var(--ui-row-height, 0px)',
        }}
        onMouseEnter={(event) => {
          hoverEnter({ kind: 'node', id: node.id }, event.currentTarget);
        }}
        onMouseLeave={() => {
          hoverLeave();
        }}
        onClick={() => {
          hoverDismiss();
          if (agentChanged) useAgentActivityStore.getState().clearTouched('node', node.id);
          activateTarget({ entityType: 'node', id: node.id });
        }}
        onDoubleClick={presentation === 'desktop' ? () => promoteCurrentTab() : undefined}
      >
        {agentAdded || agentChanged ? (
          <AgentChangeIndicator
            onClick={() => useAgentActivityStore.getState().markSeen([entityKey('node', node.id)])}
            title={t(agentAdded ? 'agentActivity.addedHere' : 'agentActivity.changedHere')}
            style={{
              width: 14,
              flexShrink: 0,
              textAlign: 'center',
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--ui-font-caption, 10px)',
              fontWeight: 600,
              lineHeight: 1,
              color: 'hsl(var(--ink-2))',
            }}
          >
            {agentAdded ? 'A' : 'M'}
          </AgentChangeIndicator>
        ) : (
          // Agent status rides the seal while working: accent and pulsing.
          <KindMark
            kind="chapter"
            seed={node.id}
            color={stripeColor}
            busy={agentBusy}
            title={agentBusy ? t('agentActivity.working') : undefined}
          />
        )}

        <div
          style={{
            flex: 1,
            minWidth: 0,
            color: 'inherit',
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
              fontSize: 'var(--ui-font-caption, 9.5px)',
              color: 'var(--ui-text-muted, hsl(var(--ink-4)))',
              flexShrink: 0,
              letterSpacing: '0.04em',
            }}
          >
            {cellMeta === 'wordCount'
              ? wordCountLabel
              : cellMeta === 'both'
                ? `${wordCountLabel} · ${formatShortDate(node.updatedAt)}`
                : formatShortDate(node.updatedAt)}
          </span>
        )}
      </SandCell>
    );
  };

  const hasNodes = bookNodes.length > 0;
  const hasStorylines = storylines.length > 0;

  // Agent activity rolls up to the synthetic group exactly like activity in a
  // real storyline, so collapsed chapters still register on its header (#17).
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
      <div {...scroll}
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
            {presentation === 'mobile' && (
              <div className="m-chapter-panel__create">
                <button
                  type="button"
                  onClick={() => void handleCreateNode(null)}
                  aria-label={t('leftSidebar.actions.newChapter')}
                >
                  <BrushIcon name="plus" size={12} inline />
                  {t('leftSidebar.actions.newChapter')}
                </button>
              </div>
            )}
            {sortedNodesGlobal.map((node) => renderNodeCard(node))}
            {!hasNodes && (
              <div
                style={{
                  fontSize: 'var(--ui-font-secondary, 12px)',
                  fontFamily: 'var(--font-sans)',
                  fontStyle: 'italic',
                  color: 'var(--ui-text-muted, hsl(var(--ink-3)))',
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
            {sortedStorylines.map((storyline) => {
              const sNodes = nodesByStoryline[storyline.id] ?? [];
              const collapsed = collapsedGroupIds.has(storyline.id);
              const color = storyline.color || 'hsl(var(--ink-4))';
              // Bubble agent activity from this storyline's chapters up to its
              // group header (#17).
              const activity = aggregateActivity(
                agentActive,
                agentTouched,
                sNodes.map((n) => entityKey('node', n.id)),
              );
              const selfKey = entityKey('storyline', storyline.id);
              const agentSelfBusy = selfKey in agentActive;
              const agentSelfChanged = selfKey in agentTouched;
              return (
                <div key={storyline.id} className="left-sb-group" style={{ marginBottom: 10 }}>
                  <GroupHeaderCell
                    variant="cell"
                    name={storyline.name}
                    count={sNodes.length}
                    color={color}
                    mark={<KindMark kind="storyline" color={color} busy={activity.busy || agentSelfBusy} />}
                    selected={storyline.id === selectedStorylineId}
                    collapsed={collapsed}
                    onToggleCollapsed={() => toggleGroupCollapsed(storyline.id)}
                    onClick={() => {
                      if (agentSelfChanged) {
                        useAgentActivityStore.getState().clearTouched('storyline', storyline.id);
                      }
                      activateTarget({ entityType: 'storyline', id: storyline.id });
                    }}
                    onDoubleClick={
                      presentation === 'desktop' ? () => promoteCurrentTab() : undefined
                    }
                    onPreviewEnter={(anchor) => hoverEnter({ kind: 'storyline', id: storyline.id }, anchor)}
                    onPreviewLeave={hoverLeave}
                    addButtonTitle={t('leftSidebar.groups.newChapterInStoryline')}
                    onAdd={() => void handleCreateNode(storyline.id)}
                    agentBusy={activity.busy || agentSelfBusy}
                    agentDoneCount={activity.doneCount}
                    agentSelfChanged={agentSelfChanged}
                    agentSelfAdded={`storyline:${storyline.id}` in agentAdditions}
                    onAgentSelfSeen={() => useAgentActivityStore.getState().markSeen([selfKey])}
                    onAgentChildrenSeen={() => useAgentActivityStore.getState().markSeen(sNodes.map((node) => entityKey('node', node.id)))}
                  />

                  {!collapsed && sNodes.map((node) => renderNodeCard(node))}
                </div>
              );
            })}

            {/* Unaffiliated is deliberately appended after every persisted
              storyline. It shares the same header, spacing, collapse model,
              inner sorting and scroll container instead of owning a pinned
              footer surface. */}
            <div key={UNAFFILIATED_GROUP_ID} className="left-sb-group" style={{ marginBottom: 10 }}>
              <GroupHeaderCell
                variant="cell"
                name={t('leftSidebar.groups.unaffiliated')}
                count={unaffiliatedChapters.length}
                color="hsl(var(--ink-4))"
                mark={<KindMark kind="storyline" color="hsl(var(--ink-4))" busy={unaffiliatedActivity.busy} />}
                collapsed={collapsedGroupIds.has(UNAFFILIATED_GROUP_ID)}
                onToggleCollapsed={() => toggleGroupCollapsed(UNAFFILIATED_GROUP_ID)}
                addButtonTitle={t('leftSidebar.actions.newChapter')}
                onAdd={() => void handleCreateNode(null)}
                agentBusy={unaffiliatedActivity.busy}
                agentDoneCount={unaffiliatedActivity.doneCount}
                onAgentChildrenSeen={() => useAgentActivityStore.getState().markSeen(unaffiliatedChapters.map((node) => entityKey('node', node.id)))}
              />

              {!collapsedGroupIds.has(UNAFFILIATED_GROUP_ID) &&
                unaffiliatedChapters.map((node) => renderNodeCard(node))}
            </div>

            {!hasStorylines && (
              <div
                style={{
                  fontSize: 'var(--ui-font-secondary, 12px)',
                  fontFamily: 'var(--font-sans)',
                  fontStyle: 'italic',
                  color: 'var(--ui-text-muted, hsl(var(--ink-3)))',
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

      {hoverPreview && (
        <EntityHoverCard
          target={hoverPreview.data}
          anchor={hoverPreview.anchor}
          placement="right-start"
          pointer={hoverCard}
          onDismiss={hoverDismiss}
          actions={hoverActionsFor(hoverPreview.data)}
        />
      )}
    </div>
  );
}
