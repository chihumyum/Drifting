import { useAgentUnreadMarks } from '../../hooks/useAgentUnreadMarks';
import { AgentChangeIndicator } from './AgentChangeIndicator';
import { useSidebarPreference, useSidebarPanelState, useSidebarSelection, useSidebarPanelScroll } from '../../hooks/useSidebarPanelState';
import { useSidebarPaneId } from '../../lib/sidebar-pane-context';
import { useLeftSidebarPanelWidth } from '../../hooks/useLeftSidebarPanelWidth';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import loglevel from 'loglevel';

import { canonicalWordCount, isDrift, type BookNode } from '../../domain/book-node';
import {
  MAX_DRIFT_GROUP_DEPTH,
  ROOT_GROUP_KEY,
  buildDriftGroupChildren,
  canMoveGroupUnder,
  collectDescendantGroupIds,
  type DriftGroup,
} from '../../domain/drift-group';
import { useDataStore } from '../../store/data-store';
import { useDataStoreFields } from '../../store/use-data-store-fields';
import { useAgentActivityStore } from '../../store/agent-activity-store';
import { useAgentEditStore } from '../../store/agent-edit-store';
import { useUiStore, usePromoteCurrentTab } from '../../store/ui-store';
import { useAuthStore } from '../../store/auth';
import { useSidebarPanelNavigation as useProjectNavigation } from '../../hooks/useSidebarPanelNavigation';
import { useBookNode } from '../../usecase/useBookNode';
import { useDriftGroup } from '../../usecase/useDriftGroup';
import { entityHoverActions } from './entity-hover-actions';
import { DRIFT_MOVE_TO_GROUP_ACTION } from '../editor/EditorTopBar';
import { HoverCardHeading, HoverCardShell, type HoverAction, type HoverActionGroup } from '../ui/HoverCard';
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
import { entityKey } from '../../lib/agent/tool-entity-ref';
import { subscribeSidebarCollapse } from '../../lib/sidebar-pane-events';
import type { WorkspaceTarget } from '../../features/workspace/navigation/workspace-target';
import { BrushIcon } from '../ui/BrushIcon';

const log = loglevel.getLogger('DriftPanel');
log.setLevel(loglevel.levels.WARN);

// 宽度低于此值时隐藏 cell 右侧的 meta（日期/字数），优先保证 title 显示。
const META_HIDE_WIDTH = 200;
// 每嵌套一层向右缩进的像素（与 GroupHeaderCell 内边距 14 对齐）。
const INDENT_STEP = 14;
// drift cell 在根层级的左内边距；每层在此基础上 + INDENT_STEP。
const DRIFT_BASE_PAD_LEFT = 22;

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

// A drift row shows its entity card; a group header shows a small card of
// its own. Both carry what the right-click menus used to.
type DriftHoverTarget = EntityHoverTarget | { kind: 'drift-group'; id: string; depth: number };

interface DriftPanelProps {
  presentation?: 'desktop' | 'mobile';
  activeTarget?: WorkspaceTarget | null;
  onPreviewTarget?: (target: WorkspaceTarget) => void;
}

export function DriftPanel({
  presentation = 'desktop',
  activeTarget = null,
  onPreviewTarget,
}: DriftPanelProps = {}) {
  const { t } = useTranslation();
  const { bookNodes } = useDataStoreFields('bookNodes');
  const driftGroups = useDataStore((s) => s.driftGroups);
  const driftGroupById = useMemo(() => new Map(driftGroups.map((group) => [group.id, group])), [driftGroups]);
  const nodeUi = useUiStore((s) => s.nodeUi);
  const sidebarWidth = useLeftSidebarPanelWidth();
  const paneId = useSidebarPaneId();
  const [cellMeta] = useSidebarPreference('driftCellMeta');
  const showMeta = presentation === 'desktop' && sidebarWidth >= META_HIDE_WIDTH;
  const [sortMode] = useSidebarPreference('driftSortMode');
  const { projectId, openEntity } = useProjectNavigation();
  const userId = useAuthStore((s) => s.user?.id);
  const promoteCurrentTab = usePromoteCurrentTab(projectId);
  const fallbackSelectedId = presentation === 'mobile' && activeTarget?.entityType === 'node'
      ? activeTarget.id
      : nodeUi.selectedId;
  const [selection] = useSidebarSelection(fallbackSelectedId ? { entityType: 'node', id: fallbackSelectedId } : null);
  const selectedNodeId = selection?.entityType === 'node' ? selection.id : null;
  const scroll = useSidebarPanelScroll();
  const activateTarget = useCallback(
    (target: WorkspaceTarget, options?: { preview?: boolean }) => {
      if (onPreviewTarget) onPreviewTarget(target);
      else openEntity(target, options);
    },
    [onPreviewTarget, openEntity],
  );
  const agentActive = useAgentActivityStore((s) => s.active);
  const agentTouched = useAgentUnreadMarks();
  // Persisted pending agent edits — keeps "M" visible after a reload.
  const agentAdditions = useAgentEditStore((s) => s.additions);
  const agentPending = useAgentEditStore((s) => s.pending);

  const { createNode } = useBookNode({ projectId: projectId ?? '', userId: userId ?? '' });
  const { createGroup, renameGroup, moveGroup, deleteGroup, moveDriftToGroup } = useDriftGroup({
    projectId: projectId ?? '',
  });

  // Collapse is local component state (not persisted), mirroring ChapterPanel's
  // storyline-collapse. A group id present in the set is collapsed.
  const [collapsedGroupIds, setCollapsedGroupIds] = useSidebarPanelState<Set<string>>('collapsed', () => new Set());
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);

  const toggleCollapsed = useCallback((id: string) => {
    setCollapsedGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, [setCollapsedGroupIds]);
  const expandGroup = useCallback((id: string) => {
    setCollapsedGroupIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, [setCollapsedGroupIds]);

  // Sub-header broadcasts a collapse-all request (same affordance ChapterPanel
  // uses). Toggle between "all open" and "all collapsed" based on current state.
  useEffect(() => {
    const handler = () => {
      const ids = useDataStore.getState().driftGroups.map((g) => g.id);
      setCollapsedGroupIds((prev) => (prev.size > 0 ? new Set() : new Set(ids)));
    };
    return subscribeSidebarCollapse('drift', paneId, handler);
  }, [paneId, setCollapsedGroupIds]);

  // Sort drifts (both drifting + resting, mixed) by the SortMenu mode, then
  // bucket by their containing group. createdAt is the default since updatedAt
  // gets bumped by wordCount sync on open (which would reorder on every click).
  const { driftsByGroup, groupChildren, descendantDriftIds } = useMemo(() => {
    const cmp = (a: BookNode, b: BookNode) => {
      if (sortMode === 'title') {
        return (a.title || '').localeCompare(b.title || '', undefined, {
          numeric: true,
          sensitivity: 'base',
        });
      }
      const key = sortMode === 'updatedAt' ? 'updatedAt' : 'createdAt';
      const av = a[key];
      const bv = b[key];
      if (av === bv) return 0;
      return bv > av ? 1 : -1;
    };
    // Defensive: a drift / sub-group whose pointer targets a group that no
    // longer exists (stale pointer from a cross-device sync race) must fall
    // back to root rather than bucket under a key nothing renders — otherwise
    // the drift (user content!) would silently vanish from the panel.
    const validIds = new Set(driftGroups.map((g) => g.id));

    const drifts = bookNodes.filter(isDrift).slice().sort(cmp);
    const byGroup = new Map<string, BookNode[]>();
    for (const node of drifts) {
      const gid = node.driftGroupId;
      const key = gid && validIds.has(gid) ? gid : ROOT_GROUP_KEY;
      const list = byGroup.get(key);
      if (list) list.push(node);
      else byGroup.set(key, [node]);
    }
    const normalizedGroups = driftGroups.map((g) =>
      g.parentGroupId && !validIds.has(g.parentGroupId) ? { ...g, parentGroupId: null } : g,
    );
    const children = buildDriftGroupChildren(normalizedGroups);

    // Per-group descendant drift ids (own + all sub-groups), for the header
    // count + agent rollup — so changes inside a collapsed subtree still surface.
    const descendants = new Map<string, string[]>();
    const compute = (groupId: string): string[] => {
      const cached = descendants.get(groupId);
      if (cached) return cached;
      const own = (byGroup.get(groupId) ?? []).map((n) => n.id);
      const all = [...own];
      for (const cg of children.get(groupId) ?? []) all.push(...compute(cg.id));
      descendants.set(groupId, all);
      return all;
    };
    for (const g of driftGroups) compute(g.id);

    return { driftsByGroup: byGroup, groupChildren: children, descendantDriftIds: descendants };
  }, [bookNodes, driftGroups, sortMode]);

  // Flattened depth-ordered group list, for the move-to-group picker.
  const flatGroups = useMemo(() => {
    const out: Array<{ group: DriftGroup; depth: number }> = [];
    const walk = (key: string, depth: number) => {
      for (const g of groupChildren.get(key) ?? []) {
        out.push({ group: g, depth });
        walk(g.id, depth + 1);
      }
    };
    walk(ROOT_GROUP_KEY, 0);
    return out;
  }, [groupChildren]);

  const dispatchEntityAction = useEntityCellAction();
  const {
    preview: hoverPreview,
    onEnter: hoverEnter,
    onLeave: hoverLeave,
    dismiss: hoverDismiss,
    card: hoverCard,
  } = useHoverPreview<DriftHoverTarget>();

  const createDriftInGroup = useCallback(
    async (groupId: string) => {
      if (!projectId) return;
      try {
        const created = await createNode({
          kind: 'drift',
          title: t('leftSidebar.actions.newDrift'),
          bookOrder: null,
          mainStorylineId: null,
          driftGroupId: groupId,
        });
        expandGroup(groupId);
        activateTarget({ entityType: 'node', id: created.id }, { preview: false });
      } catch (error) {
        log.error('Failed to create drift in group', error);
      }
    },
    [activateTarget, projectId, createNode, expandGroup, t],
  );

  const createSubGroup = useCallback(
    async (parentGroupId: string) => {
      const created = await createGroup({ parentGroupId });
      if (created) expandGroup(parentGroupId);
    },
    [createGroup, expandGroup],
  );

  const renderNodeCard = (node: BookNode, depth: number) => {
    const selected = node.id === selectedNodeId;
    const agentBusy = `node:${node.id}` in agentActive;
    const agentAdded = !agentBusy && `node:${node.id}` in agentAdditions;
    const agentChanged =
      !agentBusy &&
      !agentAdded &&
      (`node:${node.id}` in agentTouched);
    // The unread change came from an edit in another editor: blue.
    const agentExternal = agentChanged && agentPending[`node:${node.id}`]?.lastSource === 'file';
    // Merged display: resting drifts aren't bucketed into a separate drawer
    // anymore — they sit inline, distinguished only by a muted cell style.
    const muted = node.writingStatus === 'resting';
    const exactWordCount = canonicalWordCount(node);
    const wordCountLabel =
      exactWordCount == null ? t('common.counting') : formatWordCount(exactWordCount);
    // A drift is a small eddy, still turning, not yet pressed into a seal:
    // in its group's colour when the group has one, fainter when it floats
    // free of any group.
    const group = node.driftGroupId ? driftGroupById.get(node.driftGroupId) : undefined;
    const markColor = group?.color || 'hsl(var(--ink-3))';
    const padLeft = CELL_PAD_LEFT + depth * INDENT_STEP;
    return (
      <SandCell
        key={node.id}
        selected={selected}
        color={markColor}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          margin: '0 6px',
          padding: `5px 10px 5px ${padLeft}px`,
          borderRadius: 3,
          cursor: 'pointer',
          color: selected ? 'hsl(var(--ink-1))' : muted ? 'hsl(var(--ink-3))' : 'hsl(var(--ink-2))',
          fontSize: 'var(--ui-font-body, 12.5px)',
          lineHeight: 'var(--ui-line-body, 1.35)',
          minHeight: 'var(--ui-row-height, 0px)',
          opacity: muted && !selected ? 0.7 : 1,
          transition: 'opacity 0.1s',
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
        {/* Drift mark — the eddy, or Agent file status (A/M). */}
        {agentAdded || agentChanged ? (
          <AgentChangeIndicator
            onClick={() => useAgentActivityStore.getState().markSeen([entityKey('node', node.id)])}
            title={t(agentExternal ? 'agentActivity.externalChangedHere' : agentAdded ? 'agentActivity.addedHere' : 'agentActivity.changedHere')}
            external={agentExternal}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              fontWeight: 600,
              color: agentExternal ? 'hsl(var(--external-ink))' : 'hsl(var(--ink-2))',
              flexShrink: 0,
              lineHeight: 1,
              width: 14,
              textAlign: 'center',
            }}
          >
            {agentAdded ? 'A' : 'M'}
          </AgentChangeIndicator>
        ) : (
          <KindMark
            kind="drift"
            color={markColor}
            loose={!group}
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

  const renderGroup = (group: DriftGroup, depth: number) => {
    const collapsed = collapsedGroupIds.has(group.id);
    const descIds = descendantDriftIds.get(group.id) ?? [];
    const indentPad = depth * INDENT_STEP;
    // The whole header row anchors the group's card.
    const groupHover = {
      onMouseEnter: (event: React.MouseEvent<HTMLElement>) =>
        hoverEnter({ kind: 'drift-group', id: group.id, depth }, event.currentTarget),
      onMouseLeave: hoverLeave,
    };

    let header: React.ReactNode;
    if (renamingGroupId === group.id) {
      header = (
        <GroupRenameRow
          initial={group.name}
          paddingLeft={(depth === 0 ? 14 : DRIFT_BASE_PAD_LEFT) + indentPad}
          onCommit={(name) => {
            void renameGroup(group.id, name);
            setRenamingGroupId(null);
          }}
          onCancel={() => setRenamingGroupId(null)}
        />
      );
    } else if (depth === 0) {
      // Top-level group: prominent header (chevron + folder glyph — set apart
      // from the category color dot — + count + add buttons + agent rollup).
      const activity = aggregateActivity(
        agentActive,
        agentTouched,
        descIds.map((id) => entityKey('node', id)),
      );
      header = (
        <div style={{ paddingLeft: indentPad }} {...groupHover}>
          <GroupHeaderCell
            name={group.name}
            count={descIds.length}
            color={group.color || 'hsl(var(--ink-4))'}
            glyph={<BrushIcon name="folder" size={11} />}
            collapsed={collapsed}
            onToggleCollapsed={() => toggleCollapsed(group.id)}
            onClick={() => {
              hoverDismiss();
              toggleCollapsed(group.id);
            }}
            onDoubleClick={() => setRenamingGroupId(group.id)}
            addButtonTitle={t('leftSidebar.groups.newDriftInGroup')}
            onAdd={() => void createDriftInGroup(group.id)}
            rightExtra={
              // Sub-group affordance only on groups shallow enough to nest one
              // more level (temporary 2-level cap).
              depth < MAX_DRIFT_GROUP_DEPTH - 1 ? (
                <button
                  type="button"
                  className="left-sb-group-add left-sb-inline-add-button"
                  title={t('leftSidebar.groups.newSubGroup')}
                  onClick={(event) => {
                    event.stopPropagation();
                    void createSubGroup(group.id);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 18,
                    height: 18,
                  }}
                >
                  <BrushIcon name="folder-plus" size={12} />
                </button>
              ) : undefined
            }
            agentBusy={activity.busy}
            agentDoneCount={activity.doneCount}
            onAgentChildrenSeen={() => useAgentActivityStore.getState().markSeen(descIds.map((id) => entityKey('node', id)))}
          />
        </div>
      );
    } else {
      // Sub-group (level 2): compact, understated row in the same spirit as the
      // element panel's secondary group header — a small caret + mono label +
      // count, with a hover-revealed "+ drift" button. Click toggles collapse,
      // double-click renames, resting on it shows the group's card.
      header = (
        <div
          className="left-sb-inline-group-header"
          {...groupHover}
          onClick={() => {
            hoverDismiss();
            toggleCollapsed(group.id);
          }}
          onDoubleClick={() => setRenamingGroupId(group.id)}
          title={t('leftSidebar.groups.clickCollapseRename')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: `3px 10px 3px ${DRIFT_BASE_PAD_LEFT + indentPad}px`,
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--ui-font-caption, 9px)',
            lineHeight: 1.2,
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            color: 'var(--ui-text-muted, hsl(var(--ink-4)))',
            cursor: 'pointer',
          }}
        >
          {collapsed ? (
            <BrushIcon name="chevron-right" size={9} style={{ flexShrink: 0 }} />
          ) : (
            <BrushIcon name="chevron-down" size={9} style={{ flexShrink: 0 }} />
          )}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {group.name}
          </span>
          <span style={{ flexShrink: 0 }}>· {descIds.length}</span>
          <button
            type="button"
            className="left-sb-group-add left-sb-inline-add-button"
            title={t('leftSidebar.groups.newDriftInGroup')}
            onClick={(event) => {
              event.stopPropagation();
              void createDriftInGroup(group.id);
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 15,
              height: 15,
              flexShrink: 0,
            }}
          >
            <BrushIcon name="plus" size={11} />
          </button>
        </div>
      );
    }

    return (
      <div key={group.id} className="left-sb-group">
        {header}
        {!collapsed && renderGroupBody(group.id, depth + 1)}
      </div>
    );
  };

  // Render the contents (sub-groups then drifts) directly inside a group, or at
  // the root when groupId is null.
  const renderGroupBody = (groupId: string | null, depth: number) => {
    const key = groupId ?? ROOT_GROUP_KEY;
    const subgroups = groupChildren.get(key) ?? [];
    const drifts = driftsByGroup.get(key) ?? [];
    return (
      <>
        {subgroups.map((g) => renderGroup(g, depth))}
        {drifts.map((n) => renderNodeCard(n, depth))}
      </>
    );
  };

  const totalDrift = bookNodes.filter(isDrift).length;
  const isEmpty = totalDrift === 0 && driftGroups.length === 0;

  // ---- Move-to-group choices, unfolded inside a card ----
  // Root first; sub-groups read as "parent / child" in the flat row.
  const groupPath = (group: DriftGroup) => {
    const parent = group.parentGroupId ? driftGroupById.get(group.parentGroupId) : undefined;
    return parent ? `${parent.name} / ${group.name}` : group.name;
  };
  const moveChoices = (kind: 'drift' | 'group', id: string): HoverAction[] => {
    if (kind === 'drift') {
      const current = bookNodes.find((n) => n.id === id)?.driftGroupId ?? null;
      return [
        {
          key: 'root',
          label: t('leftSidebar.groups.moveDriftToRoot'),
          icon: { brush: 'folder-none' as const },
          active: current == null,
          disabled: current == null,
          onSelect: () => void moveDriftToGroup(id, null),
        },
        ...flatGroups.map(({ group }) => ({
          key: group.id,
          label: groupPath(group),
          icon: { kind: 'drift-group' as const, color: group.color ?? undefined },
          active: group.id === current,
          disabled: group.id === current,
          onSelect: () => void moveDriftToGroup(id, group.id),
        })),
      ];
    }
    const group = driftGroups.find((g) => g.id === id);
    const currentParent = group?.parentGroupId ?? null;
    // Can't move a group into itself or its own subtree.
    const blocked = new Set([id, ...collectDescendantGroupIds(driftGroups, id)]);
    return [
      {
        key: 'root',
        label: t('leftSidebar.groups.moveGroupToRoot'),
        icon: { brush: 'folder-none' as const },
        active: currentParent == null,
        disabled: currentParent == null || !canMoveGroupUnder(driftGroups, id, null),
        onSelect: () => void moveGroup(id, null),
      },
      // Disable self/subtree, the current parent, and any target that would
      // push this group's subtree past the 2-level cap.
      ...flatGroups.map(({ group: g }) => ({
        key: g.id,
        label: groupPath(g),
        icon: { kind: 'drift-group' as const, color: g.color ?? undefined },
        active: g.id === currentParent,
        disabled: blocked.has(g.id) || g.id === currentParent || !canMoveGroupUnder(driftGroups, id, g.id),
        onSelect: () => void moveGroup(id, g.id),
      })),
    ];
  };

  const driftActions = (node: BookNode): HoverActionGroup[] =>
    entityHoverActions({
      editorType: 'node',
      nodeStatusKind: 'drift',
      nodeWritingStatus: node.writingStatus,
      onAction: (action) => void dispatchEntityAction({ entityType: 'node', id: node.id, action }),
      t,
    }).map((group) => ({
      ...group,
      // "移动到分组…" is a shared getMenuItems entry; here it unfolds the
      // groups to choose from instead of routing to the entity dispatcher.
      actions: group.actions.map((action) => action.key === DRIFT_MOVE_TO_GROUP_ACTION
        ? { key: action.key, label: action.label, choices: moveChoices('drift', node.id) }
        : action),
    }));

  const groupActions = (groupId: string, depth: number): HoverActionGroup[] => [
    {
      key: 'create',
      actions: [
        // "新建子分组" gated by the 2-level nesting cap.
        ...(depth < MAX_DRIFT_GROUP_DEPTH - 1
          ? [{ key: 'new-sub', label: t('leftSidebar.groups.newSubGroup'), icon: { brush: 'folder-plus' as const }, onSelect: () => void createSubGroup(groupId) }]
          : []),
        { key: 'new-drift', label: t('leftSidebar.groups.newDriftInGroup'), icon: { brush: 'plus' as const }, onSelect: () => void createDriftInGroup(groupId) },
      ],
    },
    {
      key: 'edit',
      actions: [
        { key: 'rename', label: t('leftSidebar.groups.rename'), icon: { brush: 'edit' as const }, onSelect: () => setRenamingGroupId(groupId) },
        { key: 'move', label: t('leftSidebar.groups.moveToGroup'), choices: moveChoices('group', groupId) },
        { key: 'delete', label: t('leftSidebar.groups.deleteGroup'), icon: { brush: 'trash' as const }, danger: true, onSelect: () => void deleteGroup(groupId) },
      ],
    },
  ];

  const renderHoverCard = () => {
    if (!hoverPreview) return null;
    const { data, anchor } = hoverPreview;
    if (data.kind === 'drift-group') {
      const group = driftGroupById.get(data.id);
      if (!group) return null;
      return (
        <HoverCardShell anchor={anchor} placement="right-start" label={group.name}
          pointer={hoverCard} onDismiss={hoverDismiss} actions={groupActions(group.id, data.depth)}>
          <HoverCardHeading title={group.name} mark={{ kind: 'drift-group', color: group.color ?? undefined }}
            index={t('leftSidebar.groups.driftCount', { count: (descendantDriftIds.get(group.id) ?? []).length })} />
        </HoverCardShell>
      );
    }
    const node = data.kind === 'node' ? bookNodes.find((n) => n.id === data.id) : undefined;
    return (
      <EntityHoverCard target={data} anchor={anchor} placement="right-start"
        pointer={hoverCard} onDismiss={hoverDismiss} actions={node ? driftActions(node) : undefined} />
    );
  };

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
          padding: '6px 0 12px',
        }}
      >
        {isEmpty ? (
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
            {t('leftSidebar.empty.noDrifts')}
          </div>
        ) : (
          renderGroupBody(null, 0)
        )}
      </div>

      {renderHoverCard()}
    </div>
  );
}
// Inline rename row shown in place of a group header while editing its name.
// Enter / blur commits; Escape cancels. Styled to line up with GroupHeaderCell.
function GroupRenameRow({
  initial,
  paddingLeft,
  onCommit,
  onCancel,
}: {
  initial: string;
  paddingLeft: number;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div style={{ padding: `4px 12px 4px ${paddingLeft}px` }}>
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onCommit(value);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => onCommit(value)}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          padding: '2px 6px',
          border: '1px solid hsl(var(--accent))',
          borderRadius: 3,
          background: 'hsl(var(--paper))',
          color: 'hsl(var(--ink-1))',
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--ui-font-caption, 10px)',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          outline: 'none',
        }}
      />
    </div>
  );
}
