import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Folder, FolderPlus, Plus } from 'lucide-react';
import loglevel from 'loglevel';

import { isDrift, type BookNode } from '../../domain/book-node';
import {
  MAX_DRIFT_GROUP_DEPTH,
  ROOT_GROUP_KEY,
  buildDriftGroupChildren,
  canMoveGroupUnder,
  collectDescendantGroupIds,
  type DriftGroup,
} from '../../domain/drift-group';
import { useDataStore } from '../../store/data-store';
import { useAgentActivityStore } from '../../store/agent-activity-store';
import { useAgentEditStore } from '../../store/agent-edit-store';
import { useUiStore, usePromoteCurrentTab } from '../../store/ui-store';
import { useAuthStore } from '../../store/auth';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { useBookNode } from '../../usecase/useBookNode';
import { useDriftGroup } from '../../usecase/useDriftGroup';
import { EntityCellContextMenu } from './EntityCellContextMenu';
import { DRIFT_MOVE_TO_GROUP_ACTION } from '../editor/EditorTopBar';
import { SimpleContextMenu, type SimpleMenuItem } from './SimpleContextMenu';
import { GroupHeaderCell } from './GroupHeaderCell';
import { EntityHoverCard } from '../ui/EntityHoverCard';
import { useHoverPreview, type EntityHoverTarget } from '../ui/entity-hover-card-model';
import { aggregateActivity } from './agentActivityBubble';
import { useEntityCellAction } from '../../hooks/useEntityCellAction';
import { entityKey } from '../../lib/agent/tool-entity-ref';
import { events } from '../../lib/events';

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

type GroupMenu = { x: number; y: number; groupId: string; depth: number };
type MovePicker = { x: number; y: number; kind: 'drift' | 'group'; id: string };

export function DriftPanel() {
  const { t } = useTranslation();
  const { bookNodes } = useDataStore();
  const driftGroups = useDataStore((s) => s.driftGroups);
  const { nodeUi } = useUiStore();
  const sidebarWidth = useUiStore((s) => s.sidebars.left.width);
  const cellMeta = useUiStore((s) => s.driftCellMeta);
  const showMeta = sidebarWidth >= META_HIDE_WIDTH;
  const sortMode = useUiStore((s) => s.driftSortMode);
  const { projectId, openEntity } = useProjectNavigation();
  const userId = useAuthStore((s) => s.user?.id);
  const promoteCurrentTab = usePromoteCurrentTab(projectId);
  const selectedNodeId = nodeUi.selectedId;
  const agentActive = useAgentActivityStore((s) => s.active);
  const agentTouched = useAgentActivityStore((s) => s.touched);
  // Persisted pending agent edits — keeps "M" visible after a reload.
  const agentPending = useAgentEditStore((s) => s.pending);

  const { createNode } = useBookNode({ projectId: projectId ?? '', userId: userId ?? '' });
  const { createGroup, renameGroup, moveGroup, deleteGroup, moveDriftToGroup } = useDriftGroup({
    projectId: projectId ?? '',
  });

  // Collapse is local component state (not persisted), mirroring ChapterPanel's
  // storyline-collapse. A group id present in the set is collapsed.
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(new Set());
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);

  const toggleCollapsed = useCallback((id: string) => {
    setCollapsedGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const expandGroup = useCallback((id: string) => {
    setCollapsedGroupIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // Sub-header broadcasts a collapse-all request (same affordance ChapterPanel
  // uses). Toggle between "all open" and "all collapsed" based on current state.
  useEffect(() => {
    const handler = () => {
      const ids = useDataStore.getState().driftGroups.map((g) => g.id);
      setCollapsedGroupIds((prev) => (prev.size > 0 ? new Set() : new Set(ids)));
    };
    events.on('left-sidebar:collapse-all', handler);
    return () => events.off('left-sidebar:collapse-all', handler);
  }, []);

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
  const [contextMenu, setContextMenu] = useState<
    | {
        x: number;
        y: number;
        nodeId: string;
        writingStatus: BookNode['writingStatus'];
      }
    | null
  >(null);
  const [groupMenu, setGroupMenu] = useState<GroupMenu | null>(null);
  const [movePicker, setMovePicker] = useState<MovePicker | null>(null);

  const {
    preview: hoverPreview,
    onEnter: hoverEnter,
    onLeave: hoverLeave,
  } = useHoverPreview<EntityHoverTarget>();

  const createDriftInGroup = useCallback(
    async (groupId: string) => {
      if (!projectId) return;
      try {
        const created = await createNode({
          kind: 'drift',
          title: 'New Drift',
          bookOrder: null,
          mainStorylineId: null,
          driftGroupId: groupId,
        });
        expandGroup(groupId);
        openEntity({ entityType: 'node', id: created.id }, { preview: false });
      } catch (error) {
        log.error('Failed to create drift in group', error);
      }
    },
    [projectId, createNode, openEntity, expandGroup],
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
    const agentChanged =
      !agentBusy && (`node:${node.id}` in agentTouched || `node:${node.id}` in agentPending);
    // Merged display: resting drifts aren't bucketed into a separate drawer
    // anymore — they sit inline, distinguished only by a muted cell style.
    const muted = node.writingStatus === 'resting';
    return (
      <div
        key={node.id}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: `5px 14px 5px ${DRIFT_BASE_PAD_LEFT + depth * INDENT_STEP}px`,
          cursor: 'pointer',
          position: 'relative',
          background: selected ? 'hsl(var(--accent) / 0.10)' : 'transparent',
          color: selected
            ? 'hsl(var(--ink-1))'
            : muted
              ? 'hsl(var(--ink-3))'
              : 'hsl(var(--ink-2))',
          fontSize: 12.5,
          lineHeight: 1.35,
          opacity: muted && !selected ? 0.7 : 1,
          transition: 'background 0.1s, opacity 0.1s',
        }}
        onMouseEnter={(event) => {
          if (!selected) {
            event.currentTarget.style.background = 'hsl(var(--ink-1) / 0.03)';
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
            writingStatus: node.writingStatus,
          });
        }}
      >
        {/* Drift mark — ❦ glyph (or "M" once an agent has touched it). */}
        <span
          aria-hidden
          className={agentBusy ? 'agent-glyph-busy' : undefined}
          title={
            agentBusy
              ? t('agentActivity.working')
              : agentChanged
                ? t('agentActivity.changedHere')
                : undefined
          }
          style={{
            fontFamily: agentChanged ? 'var(--font-mono)' : 'var(--font-sans)',
            fontStyle: agentChanged ? 'normal' : 'italic',
            fontSize: agentChanged ? 10 : 11,
            fontWeight: agentChanged ? 600 : undefined,
            color: agentBusy
              ? 'hsl(var(--accent))'
              : agentChanged
                ? 'hsl(var(--ink-2))'
                : muted
                  ? 'hsl(var(--ink-4))'
                  : 'hsl(var(--ink-3))',
            flexShrink: 0,
            lineHeight: 1,
            width: 12,
            textAlign: 'center',
          }}
        >
          {agentChanged ? 'M' : '❦'}
        </span>

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

  const renderGroup = (group: DriftGroup, depth: number) => {
    const collapsed = collapsedGroupIds.has(group.id);
    const descIds = descendantDriftIds.get(group.id) ?? [];
    const indentPad = depth * INDENT_STEP;
    const openGroupMenu = (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setGroupMenu({ x: event.clientX, y: event.clientY, groupId: group.id, depth });
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
        <div style={{ paddingLeft: indentPad }}>
          <GroupHeaderCell
            name={group.name}
            count={descIds.length}
            color={group.color || 'hsl(var(--ink-4))'}
            glyph={<Folder size={11} strokeWidth={1.8} />}
            collapsed={collapsed}
            onToggleCollapsed={() => toggleCollapsed(group.id)}
            onClick={() => toggleCollapsed(group.id)}
            onDoubleClick={() => setRenamingGroupId(group.id)}
            onContextMenu={openGroupMenu}
            addButtonTitle={t('leftSidebar.groups.newDriftInGroup')}
            onAdd={() => void createDriftInGroup(group.id)}
            rightExtra={
              // Sub-group affordance only on groups shallow enough to nest one
              // more level (temporary 2-level cap).
              depth < MAX_DRIFT_GROUP_DEPTH - 1 ? (
                <button
                  type="button"
                  className="left-sb-group-add"
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
                    borderRadius: 3,
                    border: 'none',
                    background: 'transparent',
                    color: 'hsl(var(--ink-4))',
                    cursor: 'pointer',
                    padding: 0,
                    transition: 'opacity 0.12s, background 0.12s, color 0.12s',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'hsl(var(--paper-deep))';
                    e.currentTarget.style.color = 'hsl(var(--ink-1))';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                    e.currentTarget.style.color = 'hsl(var(--ink-4))';
                  }}
                >
                  <FolderPlus size={12} strokeWidth={1.6} />
                </button>
              ) : undefined
            }
            agentBusy={activity.busy}
            agentDoneCount={activity.doneCount}
          />
        </div>
      );
    } else {
      // Sub-group (level 2): compact, understated row in the same spirit as the
      // element panel's secondary group header — a small caret + mono label +
      // count, with a hover-revealed "+ drift" button. Click toggles collapse,
      // double-click renames, right-click opens the group menu.
      header = (
        <div
          onClick={() => toggleCollapsed(group.id)}
          onDoubleClick={() => setRenamingGroupId(group.id)}
          onContextMenu={openGroupMenu}
          title={t('leftSidebar.groups.clickCollapseRename')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: `3px 10px 3px ${DRIFT_BASE_PAD_LEFT + indentPad}px`,
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            lineHeight: 1.2,
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            color: 'hsl(var(--ink-4))',
            cursor: 'pointer',
          }}
        >
          {collapsed ? (
            <ChevronRight size={9} strokeWidth={2} style={{ flexShrink: 0 }} />
          ) : (
            <ChevronDown size={9} strokeWidth={2} style={{ flexShrink: 0 }} />
          )}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {group.name}
          </span>
          <span style={{ flexShrink: 0 }}>· {descIds.length}</span>
          <button
            type="button"
            className="left-sb-group-add"
            title={t('leftSidebar.groups.newDriftInGroup')}
            onClick={(event) => {
              event.stopPropagation();
              void createDriftInGroup(group.id);
            }}
            style={{
              marginLeft: 'auto',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 15,
              height: 15,
              borderRadius: 3,
              border: 'none',
              background: 'transparent',
              color: 'hsl(var(--ink-4))',
              cursor: 'pointer',
              padding: 0,
              flexShrink: 0,
              transition: 'opacity 0.12s, background 0.12s, color 0.12s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'hsl(var(--paper-deep))';
              e.currentTarget.style.color = 'hsl(var(--ink-1))';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = 'hsl(var(--ink-4))';
            }}
          >
            <Plus size={11} strokeWidth={1.8} />
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

  // ---- Move-to-group picker items ----
  const buildMoveItems = (picker: MovePicker): SimpleMenuItem[] => {
    const items: SimpleMenuItem[] = [];
    if (picker.kind === 'drift') {
      const node = bookNodes.find((n) => n.id === picker.id);
      const current = node?.driftGroupId ?? null;
      items.push({
        key: 'root',
        label: t('leftSidebar.groups.moveDriftToRoot'),
        disabled: current == null,
        trailing: current == null ? <span aria-hidden>✓</span> : undefined,
        onClick: () => void moveDriftToGroup(picker.id, null),
      });
      flatGroups.forEach(({ group, depth }, idx) => {
        items.push({
          key: group.id,
          label: group.name,
          indent: (depth + 1) * 12,
          dividerBefore: idx === 0,
          disabled: group.id === current,
          trailing: group.id === current ? <span aria-hidden>✓</span> : undefined,
          onClick: () => void moveDriftToGroup(picker.id, group.id),
        });
      });
    } else {
      const group = driftGroups.find((g) => g.id === picker.id);
      const currentParent = group?.parentGroupId ?? null;
      // Can't move a group into itself or its own subtree.
      const blocked = new Set([picker.id, ...collectDescendantGroupIds(driftGroups, picker.id)]);
      items.push({
        key: 'root',
        label: t('leftSidebar.groups.moveGroupToRoot'),
        disabled: currentParent == null || !canMoveGroupUnder(driftGroups, picker.id, null),
        trailing: currentParent == null ? <span aria-hidden>✓</span> : undefined,
        onClick: () => void moveGroup(picker.id, null),
      });
      flatGroups.forEach(({ group: g, depth }, idx) => {
        // Disable self/subtree, the current parent, and any target that would
        // push this group's subtree past the 2-level cap.
        const disabled =
          blocked.has(g.id) ||
          g.id === currentParent ||
          !canMoveGroupUnder(driftGroups, picker.id, g.id);
        items.push({
          key: g.id,
          label: g.name,
          indent: (depth + 1) * 12,
          dividerBefore: idx === 0,
          disabled,
          trailing: g.id === currentParent ? <span aria-hidden>✓</span> : undefined,
          onClick: () => void moveGroup(picker.id, g.id),
        });
      });
    }
    return items;
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
      <div
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
              fontSize: 12,
              fontFamily: 'var(--font-sans)',
              fontStyle: 'italic',
              color: 'hsl(var(--ink-3))',
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
          nodeStatusKind="drift"
          nodeWritingStatus={contextMenu.writingStatus}
          onAction={(action) => {
            // "移动到分组…" is a shared getMenuItems entry — intercept it here to
            // open the group picker instead of routing to the entity dispatcher.
            if (action === DRIFT_MOVE_TO_GROUP_ACTION) {
              setMovePicker({
                x: contextMenu.x,
                y: contextMenu.y,
                kind: 'drift',
                id: contextMenu.nodeId,
              });
              return;
            }
            void dispatchEntityAction({
              entityType: 'node',
              id: contextMenu.nodeId,
              action,
            });
          }}
          onClose={() => setContextMenu(null)}
        />
      )}

      {groupMenu && (
        <SimpleContextMenu
          x={groupMenu.x}
          y={groupMenu.y}
          onClose={() => setGroupMenu(null)}
          items={[
            // "新建子分组" gated by the 2-level nesting cap.
            ...(groupMenu.depth < MAX_DRIFT_GROUP_DEPTH - 1
              ? [
                  {
                    key: 'new-sub',
                    label: t('leftSidebar.groups.newSubGroup'),
                    onClick: () => void createSubGroup(groupMenu.groupId),
                  },
                ]
              : []),
            {
              key: 'new-drift',
              label: t('leftSidebar.groups.newDriftInGroup'),
              onClick: () => void createDriftInGroup(groupMenu.groupId),
            },
            {
              key: 'rename',
              label: t('leftSidebar.groups.rename'),
              onClick: () => setRenamingGroupId(groupMenu.groupId),
            },
            {
              key: 'move',
              label: t('leftSidebar.groups.moveToGroup'),
              onClick: () =>
                setMovePicker({
                  x: groupMenu.x,
                  y: groupMenu.y,
                  kind: 'group',
                  id: groupMenu.groupId,
                }),
            },
            {
              key: 'delete',
              label: t('leftSidebar.groups.deleteGroup'),
              danger: true,
              dividerBefore: true,
              onClick: () => void deleteGroup(groupMenu.groupId),
            },
          ]}
        />
      )}

      {movePicker && (
        <SimpleContextMenu
          x={movePicker.x}
          y={movePicker.y}
          title={
            movePicker.kind === 'drift'
              ? t('leftSidebar.groups.moveDriftTitle')
              : t('leftSidebar.groups.moveGroupTitle')
          }
          onClose={() => setMovePicker(null)}
          items={buildMoveItems(movePicker)}
        />
      )}

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
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          outline: 'none',
        }}
      />
    </div>
  );
}
