import { useCallback, useMemo } from 'react';
import { AlignLeft, GitBranch, Minus, ArrowDownUp, ListFilter, Plus } from 'lucide-react';
import loglevel from 'loglevel';

import { useDataStore } from '../../store/data-store';
import { useUiStore } from '../../store/ui-store';
import { useAuthStore } from '../../store/auth';
import { useBookNode } from '../../usecase/useBookNode';
import { useStoryline } from '../../usecase/useStoryline';
import { useBookElement } from '../../usecase/useBookElement';
import { useElementCategory } from '../../usecase/useElementCategory';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { events } from '../../lib/events';

const log = loglevel.getLogger('LeftSidebarSubHeader');
log.setLevel(loglevel.levels.ERROR);

export function LeftSidebarSubHeader() {
  const activeLeftPanel = useUiStore((s) => s.activeLeftPanel);
  const nodesViewMode = useUiStore((s) => s.nodesPanelViewMode);
  const setNodesViewMode = useUiStore((s) => s.setNodesPanelViewMode);

  const storylines = useDataStore((s) => s.storylines);
  const bookNodes = useDataStore((s) => s.bookNodes);
  const bookElements = useDataStore((s) => s.bookElements);
  const bookElementCategories = useDataStore((s) => s.bookElementCategories);

  const userId = useAuthStore((s) => s.user?.id);
  const { projectId, openEntity } = useProjectNavigation();

  const driftCount = useMemo(() => bookNodes.filter((n) => n.mainStorylineId == null).length, [
    bookNodes,
  ]);
  const storylineNodeCount = useMemo(
    () => bookNodes.filter((n) => n.mainStorylineId != null).length,
    [bookNodes],
  );

  const { createNode } = useBookNode({
    projectId: projectId ?? '',
    userId: userId ?? '',
  });
  const { createStoryline } = useStoryline({
    projectId: projectId ?? '',
    userId: userId ?? '',
  });
  const { createElement } = useBookElement({
    projectId: projectId ?? '',
    userId: userId ?? '',
  });
  const { createCategory } = useElementCategory({
    projectId: projectId ?? '',
    userId: userId ?? '',
  });

  const handleCreateNode = useCallback(async () => {
    if (!projectId) return;
    try {
      let mainStorylineId: string | null = storylines[0]?.id ?? null;
      if (!mainStorylineId) {
        const created = await createStoryline({ projectId });
        mainStorylineId = created.id;
      }
      const maxOrder = bookNodes.reduce((max, n) => Math.max(max, n.bookOrder), 0);
      const nextOrder = maxOrder + 1;
      const created = await createNode({
        title: 'New Chapter',
        bookOrder: nextOrder,
        mainStorylineId,
      });
      openEntity({ entityType: 'node', id: created.id }, { preview: false });
    } catch (error) {
      log.error('Failed to create node', error);
    }
  }, [projectId, storylines, bookNodes, createNode, createStoryline, openEntity]);

  const handleCreateStoryline = useCallback(async () => {
    if (!projectId) return;
    try {
      const created = await createStoryline({ projectId, name: 'New Storyline' });
      openEntity({ entityType: 'storyline', id: created.id }, { preview: false });
    } catch (error) {
      log.error('Failed to create storyline', error);
    }
  }, [projectId, createStoryline, openEntity]);

  const handleCreateDrift = useCallback(async () => {
    if (!projectId) return;
    try {
      const maxOrder = bookNodes.reduce((max, n) => Math.max(max, n.bookOrder), 0);
      const nextOrder = maxOrder + 1;
      const created = await createNode({
        title: 'New Drift',
        bookOrder: nextOrder,
        mainStorylineId: null,
      });
      openEntity({ entityType: 'node', id: created.id }, { preview: false });
    } catch (error) {
      log.error('Failed to create drift node', error);
    }
  }, [projectId, bookNodes, createNode, openEntity]);

  const handleCreateElement = useCallback(async () => {
    if (!projectId) return;
    try {
      // Default new elements into the first user-defined category; fall back
      // to "others" (reserved) when no other category exists, or create one
      // on demand if the project has nothing at all.
      let categoryId = bookElementCategories.find((c) => c.name !== 'others')?.id;
      if (!categoryId) categoryId = bookElementCategories.find((c) => c.name === 'others')?.id;
      if (!categoryId) {
        const created = await createCategory();
        categoryId = created.id;
      }
      const created = await createElement({ categoryId });
      openEntity({ entityType: 'element', id: created.id }, { preview: false });
    } catch (error) {
      log.error('Failed to create element', error);
    }
  }, [projectId, bookElementCategories, createElement, createCategory, openEntity]);

  const handleCreateCategory = useCallback(async () => {
    if (!projectId) return;
    try {
      await createCategory();
    } catch (error) {
      log.error('Failed to create category', error);
    }
  }, [projectId, createCategory]);

  const meta =
    activeLeftPanel === 'nodes'
      ? `${storylines.length} STORYLINES · ${storylineNodeCount} 章`
      : activeLeftPanel === 'elements'
        ? `${bookElementCategories.length} 类 · ${bookElements.length} 元素`
        : `${driftCount} 灵感`;

  const collapseAll = useCallback(() => {
    events.emit('left-sidebar:collapse-all');
  }, []);

  const renderViewToggle = () => {
    if (activeLeftPanel !== 'nodes') return null;
    return (
      <div style={{ display: 'inline-flex', marginRight: 4 }}>
        <ViewToggleBtn
          active={nodesViewMode === 'global'}
          title="按章节顺序"
          first
          onClick={() => setNodesViewMode('global')}
        >
          <AlignLeft size={11} strokeWidth={1.8} />
        </ViewToggleBtn>
        <ViewToggleBtn
          active={nodesViewMode === 'storyline'}
          title="按故事线分组"
          last
          onClick={() => setNodesViewMode('storyline')}
        >
          <GitBranch size={11} strokeWidth={1.8} />
        </ViewToggleBtn>
      </div>
    );
  };

  const renderPrimaryCreate = () => {
    let onClick: () => void;
    let title: string;
    if (activeLeftPanel === 'nodes') {
      onClick = nodesViewMode === 'global' ? () => void handleCreateNode() : () => void handleCreateStoryline();
      title = nodesViewMode === 'global' ? '新章节' : '新故事线';
    } else if (activeLeftPanel === 'elements') {
      onClick = () => void handleCreateElement();
      title = '新元素';
    } else {
      onClick = () => void handleCreateDrift();
      title = '新灵感';
    }
    return (
      <SubIconBtn title={title} onClick={onClick} accent>
        <Plus size={11} strokeWidth={2} />
      </SubIconBtn>
    );
  };

  const renderSecondaryCreate = () => {
    // Elements panel exposes "new category" alongside "new element"; nodes
    // panel in storyline mode already creates a storyline via the +; nothing
    // for drift.
    if (activeLeftPanel === 'elements') {
      return (
        <SubIconBtn title="新类目" onClick={() => void handleCreateCategory()}>
          <Plus size={11} strokeWidth={1.6} />
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 8.5,
              marginLeft: 1,
              letterSpacing: '0.05em',
              color: 'inherit',
            }}
          >
            类
          </span>
        </SubIconBtn>
      );
    }
    return null;
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        padding: '6px 10px 6px 12px',
        fontFamily: 'var(--font-mono)',
        fontSize: 9.5,
        textTransform: 'uppercase',
        letterSpacing: '0.12em',
        color: 'hsl(var(--ink-3))',
        borderBottom: '1px solid hsl(var(--rule))',
        flexShrink: 0,
      }}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {meta}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        {renderViewToggle()}
        <SubIconBtn title="折叠全部" onClick={collapseAll}>
          <Minus size={11} strokeWidth={1.6} />
        </SubIconBtn>
        <SubIconBtn title="排序（待接入）" disabled>
          <ArrowDownUp size={11} strokeWidth={1.6} />
        </SubIconBtn>
        <SubIconBtn title="筛选（待接入）" disabled>
          <ListFilter size={11} strokeWidth={1.6} />
        </SubIconBtn>
        {renderSecondaryCreate()}
        {renderPrimaryCreate()}
      </div>
    </div>
  );
}

function SubIconBtn({
  title,
  onClick,
  children,
  accent,
  disabled,
}: {
  title: string;
  onClick?: () => void;
  children: React.ReactNode;
  accent?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      title={title}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 20,
        minWidth: 22,
        padding: '0 4px',
        borderRadius: 3,
        border: 'none',
        background: 'transparent',
        color: accent ? 'hsl(var(--accent))' : 'hsl(var(--ink-4))',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        transition: 'background 0.12s, color 0.12s',
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = 'hsl(var(--paper-deep))';
        e.currentTarget.style.color = 'hsl(var(--ink-1))';
      }}
      onMouseLeave={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.color = accent ? 'hsl(var(--accent))' : 'hsl(var(--ink-4))';
      }}
    >
      {children}
    </button>
  );
}

function ViewToggleBtn({
  active,
  first,
  last,
  title,
  onClick,
  children,
}: {
  active: boolean;
  first?: boolean;
  last?: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 22,
        height: 20,
        border: '1px solid hsl(var(--rule))',
        background: active ? 'hsl(var(--ink-1))' : 'transparent',
        color: active ? 'hsl(var(--paper))' : 'hsl(var(--ink-3))',
        borderColor: active ? 'hsl(var(--ink-1))' : 'hsl(var(--rule))',
        cursor: 'pointer',
        padding: 0,
        borderRadius: first ? '3px 0 0 3px' : last ? '0 3px 3px 0' : 0,
        marginLeft: first ? 0 : -1,
        transition: 'background 0.12s, color 0.12s, border-color 0.12s',
      }}
    >
      {children}
    </button>
  );
}
