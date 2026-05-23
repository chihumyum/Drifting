import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Minus, ArrowDownUp, ListFilter, Plus } from 'lucide-react';
import loglevel from 'loglevel';

import { useDataStore } from '../../store/data-store';
import { CHAPTER_ORDER_STRIDE, isChapter, isDrift } from '../../domain/book-node';
import { useUiStore } from '../../store/ui-store';
import { useAuthStore } from '../../store/auth';
import { useBookNode } from '../../usecase/useBookNode';
import { useStoryline } from '../../usecase/useStoryline';
import { useElementCategory } from '../../usecase/useElementCategory';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { events } from '../../lib/events';

const log = loglevel.getLogger('LeftSidebarSubHeader');
log.setLevel(loglevel.levels.ERROR);

// 容器宽度低于此值时隐藏左侧 meta 统计文本，把空间让给右侧操作按钮。
const META_HIDE_WIDTH = 220;

export function LeftSidebarSubHeader() {
  const activeLeftPanel = useUiStore((s) => s.activeLeftPanel);
  const nodesViewMode = useUiStore((s) => s.chapterPanelViewMode);

  const storylines = useDataStore((s) => s.storylines);
  const bookNodes = useDataStore((s) => s.bookNodes);
  const bookElements = useDataStore((s) => s.bookElements);
  const bookElementCategories = useDataStore((s) => s.bookElementCategories);

  const userId = useAuthStore((s) => s.user?.id);
  const { projectId, openEntity } = useProjectNavigation();

  const driftCount = useMemo(() => bookNodes.filter(isDrift).length, [bookNodes]);
  const storylineNodeCount = useMemo(() => bookNodes.filter(isChapter).length, [bookNodes]);

  const { createNode } = useBookNode({
    projectId: projectId ?? '',
    userId: userId ?? '',
  });
  const { createStoryline } = useStoryline({
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
      // This entry point carries no storyline context — the new chapter
      // always lands 未归属. Users curate primary storyline downstream via
      // the right sidebar / context menu / drag-drop in BottomTimeline.
      const maxOrder = bookNodes
        .filter(isChapter)
        .reduce((max, n) => Math.max(max, n.bookOrder), 0);
      const nextOrder = maxOrder + CHAPTER_ORDER_STRIDE;
      const created = await createNode({
        kind: 'chapter',
        title: 'New Chapter',
        bookOrder: nextOrder,
        mainStorylineId: null,
      });
      openEntity({ entityType: 'node', id: created.id }, { preview: false });
    } catch (error) {
      log.error('Failed to create node', error);
    }
  }, [projectId, bookNodes, createNode, openEntity]);

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
      const created = await createNode({
        kind: 'drift',
        title: 'New Drift',
        bookOrder: null,
        mainStorylineId: null,
      });
      openEntity({ entityType: 'node', id: created.id }, { preview: false });
    } catch (error) {
      log.error('Failed to create drift node', error);
    }
  }, [projectId, createNode, openEntity]);

  const handleCreateCategory = useCallback(async () => {
    if (!projectId) return;
    try {
      await createCategory();
    } catch (error) {
      log.error('Failed to create category', error);
    }
  }, [projectId, createCategory]);

  // Chapter panel meta — "N STORYLINES · M 章" only makes sense in
  // storyline-grouping mode. Global view collapses to a flat chapter list,
  // and the storyline count is irrelevant chrome there.
  const showStorylineMeta = nodesViewMode === 'storyline' && storylines.length > 0;
  const meta =
    activeLeftPanel === 'nodes'
      ? showStorylineMeta
        ? `${storylines.length} STORYLINES · ${storylineNodeCount} 章`
        : `${storylineNodeCount} 章`
      : activeLeftPanel === 'elements'
        ? `${bookElementCategories.length} 类 · ${bookElements.length} 元素`
        : `${driftCount} 浮缀`;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const [showMeta, setShowMeta] = useState(true);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => setShowMeta(el.clientWidth >= META_HIDE_WIDTH);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const collapseAll = useCallback(() => {
    events.emit('left-sidebar:collapse-all');
  }, []);

  // Chapter-panel view mode is no longer controlled here — it lives on a
  // hover dropdown attached to the 章节 tab itself (see LeftSidebarHeader).
  // The subheader keeps the value around so it can hide unrelated chrome
  // (collapse-all, "N STORYLINES" meta) when in global mode.

  const renderPrimaryCreate = () => {
    let onClick: () => void;
    let title: string;
    let icon: React.ReactNode = <Plus size={11} strokeWidth={2} />;
    if (activeLeftPanel === 'nodes') {
      // Mirror ChapterPanel: when there are no storylines the view collapses to
      // 'global', so the primary CTA must be "+ 新章节" regardless of the
      // persisted nodesViewMode value.
      const effectiveMode = storylines.length === 0 ? 'global' : nodesViewMode;
      const isStorylineMode = effectiveMode === 'storyline';
      onClick = isStorylineMode
        ? () => void handleCreateStoryline()
        : () => void handleCreateNode();
      title = isStorylineMode ? '新故事线' : '新章节';
      if (isStorylineMode) {
        // Reuse the BottomTimeline "+ storyline" glyph (horizontal lane +
        // plus above) so this button reads as a sibling of the timeline's
        // affordance. The two are the same action, surfaced from two places.
        icon = (
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <line x1="2" y1="11" x2="14" y2="11" />
            <line x1="8" y1="3" x2="8" y2="8" />
            <line x1="5.5" y1="5.5" x2="10.5" y2="5.5" />
          </svg>
        );
      }
    } else if (activeLeftPanel === 'elements') {
      // Elements panel header only exposes "new category" — each category
      // cell carries its own "+ new element" button so a hovered category
      // is the implicit target. Avoids the surprise where the header +
      // creates an element under whichever category sorts first.
      onClick = () => void handleCreateCategory();
      title = '新类目';
      // Mirror the storyline glyph's "shape + plus above" structure with two
      // stacked lines (a "group/list" of items) so the affordance reads as
      // "+ category" rather than the ambiguous bare plus that users would
      // otherwise mistake for "+ element".
      icon = (
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          <line x1="4" y1="10" x2="12" y2="10" />
          <line x1="4" y1="13" x2="12" y2="13" />
          <line x1="8" y1="3" x2="8" y2="7" />
          <line x1="6" y1="5" x2="10" y2="5" />
        </svg>
      );
    } else {
      onClick = () => void handleCreateDrift();
      title = '新浮缀';
    }
    return (
      <SubIconBtn title={title} onClick={onClick} accent>
        {icon}
      </SubIconBtn>
    );
  };

  const renderSecondaryCreate = () => {
    // Header-level "+ element" was removed — each category cell carries its
    // own element-add button. Other panels have nothing to slot here either.
    return null;
  };

  return (
    <div
      ref={rootRef}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: showMeta ? 'space-between' : 'flex-end',
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
      {showMeta && (
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {meta}
        </span>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        {/* "折叠全部" only applies to the storyline-grouping view's expandable
            storyline rows. In chapter-global view (or other panels without a
            collapsible structure) the button is meaningless, so we hide it
            entirely rather than leave it as a dead affordance. */}
        {(activeLeftPanel !== 'nodes' ||
          (storylines.length > 0 && nodesViewMode === 'storyline')) && (
          <SubIconBtn title="折叠全部" onClick={collapseAll}>
            <Minus size={11} strokeWidth={1.6} />
          </SubIconBtn>
        )}
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

