import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Minus, ArrowDownUp, Plus, FolderPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import loglevel from 'loglevel';

import { useDataStore } from '../../store/data-store';
import { CHAPTER_ORDER_STRIDE, isChapter, isDrift } from '../../domain/book-node';
import { useUiStore } from '../../store/ui-store';
import type {
  DriftSortMode,
  ChapterGlobalSortMode,
  ChapterStorylineInnerSortMode,
  ElementSortMode,
  NodeCellMeta,
} from '../../store/ui-store';
import { useAuthStore } from '../../store/auth';
import { useBookNode } from '../../usecase/useBookNode';
import { useStoryline } from '../../usecase/useStoryline';
import { useElementCategory } from '../../usecase/useElementCategory';
import { useDriftGroup } from '../../usecase/useDriftGroup';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { events } from '../../lib/events';
import { SortMenu, sortMenuGroup, type SortMenuOption } from './SortMenu';
import { Switch } from '../ui/Switch';

const log = loglevel.getLogger('LeftSidebarSubHeader');
log.setLevel(loglevel.levels.ERROR);

// 容器宽度低于此值时隐藏左侧 meta 统计文本，把空间让给右侧操作按钮。
// 之前是 220，导致默认 280 宽度的侧栏看起来正常，但稍微缩窄一点 meta 就消失。
// 实测 meta 本身只占 ~80px，右侧 4 个 26px 图标占 ~110px，总共 ~200。降到 180
// 给狭窄场景留点余量；真正窄到 < 180 才放弃 meta。
const META_HIDE_WIDTH = 180;

export function LeftSidebarSubHeader() {
  const { t } = useTranslation();
  const activeLeftPanel = useUiStore((s) => s.activeLeftPanel);
  const nodesViewMode = useUiStore((s) => s.chapterPanelViewMode);
  const setChapterViewMode = useUiStore((s) => s.setChapterPanelViewMode);

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
  const { createGroup } = useDriftGroup({ projectId: projectId ?? '' });

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

  const handleCreateDriftGroup = useCallback(async () => {
    if (!projectId) return;
    try {
      await createGroup({});
    } catch (error) {
      log.error('Failed to create drift group', error);
    }
  }, [projectId, createGroup]);

  // Chapter panel meta — just the chapter count in both view modes. The
  // storyline count lives on the view-mode switch's adjacent context, not in
  // the meta text.
  const meta =
    activeLeftPanel === 'nodes'
      ? t('leftSidebar.meta.chapters', { count: storylineNodeCount })
      : activeLeftPanel === 'elements'
        ? t('leftSidebar.meta.elements', {
            categories: bookElementCategories.length,
            elements: bookElements.length,
          })
        : t('leftSidebar.meta.drifts', { count: driftCount });

  // The 章节 panel's view-mode switch reflects the *effective* mode: a project
  // with zero storylines is forced to 'global' (mirrors ChapterPanel), so the
  // switch reads off while empty even if a 'storyline' preference is persisted.
  const isStorylineView = storylines.length > 0 && nodesViewMode === 'storyline';

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

  // Sort menu — anchored to the ArrowDownUp button. The set of options
  // depends on which panel is currently active (and, for chapters, whether
  // the layout is storyline-grouped). One menu instance is rendered per
  // panel kind so the SortMenu's typed value/onChange line up with the
  // matching ui-store field; only the active panel's instance opens.
  const sortBtnRef = useRef<HTMLButtonElement | null>(null);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);

  const driftSortMode = useUiStore((s) => s.driftSortMode);
  const setDriftSortMode = useUiStore((s) => s.setDriftSortMode);
  const chapterGlobalSortMode = useUiStore((s) => s.chapterGlobalSortMode);
  const setChapterGlobalSortMode = useUiStore((s) => s.setChapterGlobalSortMode);
  const chapterStorylineInnerSortMode = useUiStore((s) => s.chapterStorylineInnerSortMode);
  const setChapterStorylineInnerSortMode = useUiStore((s) => s.setChapterStorylineInnerSortMode);
  const elementSortMode = useUiStore((s) => s.elementSortMode);
  const setElementSortMode = useUiStore((s) => s.setElementSortMode);
  const chapterCellMeta = useUiStore((s) => s.chapterCellMeta);
  const setChapterCellMeta = useUiStore((s) => s.setChapterCellMeta);
  const driftCellMeta = useUiStore((s) => s.driftCellMeta);
  const setDriftCellMeta = useUiStore((s) => s.setDriftCellMeta);
  const chapterStorylinePrimaryOnly = useUiStore((s) => s.chapterStorylinePrimaryOnly);
  const setChapterStorylinePrimaryOnly = useUiStore((s) => s.setChapterStorylinePrimaryOnly);

  const driftSortOptions = useMemo<SortMenuOption<DriftSortMode>[]>(
    () => [
      { value: 'createdAt', label: t('leftSidebar.sort.createdAt') },
      { value: 'updatedAt', label: t('leftSidebar.sort.updatedAt') },
      { value: 'title', label: t('leftSidebar.sort.title') },
    ],
    [t],
  );
  const chapterGlobalSortOptions = useMemo<SortMenuOption<ChapterGlobalSortMode>[]>(
    () => [
      { value: 'bookOrder', label: t('leftSidebar.sort.bookOrder') },
      { value: 'narrativeOrder', label: t('leftSidebar.sort.narrativeOrder') },
      { value: 'createdAt', label: t('leftSidebar.sort.createdAt') },
      { value: 'updatedAt', label: t('leftSidebar.sort.updatedAt') },
    ],
    [t],
  );
  const chapterStorylineInnerSortOptions = useMemo<SortMenuOption<ChapterStorylineInnerSortMode>[]>(
    () => [
      { value: 'bookOrder', label: t('leftSidebar.sort.bookOrder') },
      { value: 'narrativeOrder', label: t('leftSidebar.sort.narrativeOrder') },
    ],
    [t],
  );
  const elementSortOptions = useMemo<SortMenuOption<ElementSortMode>[]>(
    () => [
      { value: 'alphabet', label: t('leftSidebar.sort.alphabet') },
      { value: 'createdAt', label: t('leftSidebar.sort.createdAt') },
    ],
    [t],
  );
  // Right-edge cell meta toggle — shared by the 章节 and 灵感 menus.
  const nodeCellMetaOptions = useMemo<SortMenuOption<NodeCellMeta>[]>(
    () => [
      { value: 'date', label: t('leftSidebar.sort.showDate') },
      { value: 'wordCount', label: t('leftSidebar.sort.showWordCount') },
      { value: 'both', label: t('leftSidebar.sort.showBoth') },
      { value: 'none', label: t('leftSidebar.sort.showNone') },
    ],
    [t],
  );
  // Storyline-grouped chapter view only: whether a chapter linked to several
  // storylines shows in every group or just its primary one.
  const chapterDuplicateOptions = useMemo<SortMenuOption<'all' | 'primary'>[]>(
    () => [
      { value: 'all', label: t('leftSidebar.sort.duplicatesAll') },
      { value: 'primary', label: t('leftSidebar.sort.duplicatesPrimary') },
    ],
    [t],
  );

  // Chapter panel splits into two menus depending on layout — global view
  // gets the four-option set; storyline view's menu controls the inner sort
  // (storylines themselves stay in their natural order, per design).
  const chapterIsStoryline =
    activeLeftPanel === 'nodes' && nodesViewMode === 'storyline' && storylines.length > 0;
  const sortMenuTitle =
    activeLeftPanel === 'drift'
      ? t('leftSidebar.sort.drifts')
      : activeLeftPanel === 'elements'
        ? t('leftSidebar.sort.elements')
        : chapterIsStoryline
          ? t('leftSidebar.sort.storylineChapters')
          : t('leftSidebar.sort.chapters');

  // Chapter-panel view mode is driven by the switch in front of the meta text
  // (全书总览 ⇄ 按 storyline 分组). Flipping it on with zero storylines bootstraps
  // the first storyline — migrating existing chapters into it — so the grouped
  // view has a lane to show, the same gesture the old hover-menu performed.
  const handleToggleChapterViewMode = useCallback(() => {
    if (isStorylineView) {
      setChapterViewMode('global');
      return;
    }
    if (storylines.length === 0) {
      if (!projectId) return;
      void (async () => {
        try {
          await createStoryline({ projectId, name: 'New Storyline' });
          setChapterViewMode('storyline');
        } catch (error) {
          log.error('Failed to create first storyline', error);
        }
      })();
      return;
    }
    setChapterViewMode('storyline');
  }, [isStorylineView, storylines.length, projectId, createStoryline, setChapterViewMode]);

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
      title = isStorylineMode
        ? t('leftSidebar.actions.newStoryline')
        : t('leftSidebar.actions.newChapter');
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
      title = t('leftSidebar.actions.newCategory');
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
      title = t('leftSidebar.actions.newDrift');
    }
    return (
      <SubIconBtn title={title} onClick={onClick} accent>
        {icon}
      </SubIconBtn>
    );
  };

  const renderSecondaryCreate = () => {
    // 灵感 panel: a "+ group" affordance next to "+ drift" (each group cell also
    // carries its own "+ drift in this group" button). Other panels have
    // nothing to slot here — the element panel's "+ element" lives per-category.
    if (activeLeftPanel === 'drift') {
      return (
        <SubIconBtn
          title={t('leftSidebar.actions.newDriftGroup')}
          onClick={() => void handleCreateDriftGroup()}
        >
          <FolderPlus size={12} strokeWidth={1.6} />
        </SubIconBtn>
      );
    }
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
        background: 'var(--workspace-ui-bg)',
        flexShrink: 0,
      }}
    >
      {showMeta && (
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            minWidth: 0,
            overflow: 'hidden',
          }}
        >
          {/* 全书总览 ⇄ 按 storyline 分组. Only the 章节 panel groups by storyline. */}
          {activeLeftPanel === 'nodes' && (
            <ViewModeSwitch
              on={isStorylineView}
              onToggle={handleToggleChapterViewMode}
              titleOn={t('leftSidebar.viewMode.storylineTitle')}
              titleOff={t('leftSidebar.viewMode.globalTitle')}
            />
          )}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {meta}
          </span>
        </span>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        {/* "折叠全部" applies to panels with collapsible groups (元素 类目 and,
            now that drifts can be grouped into folders, 灵感分组). The 章节 panel
            toggles its storyline lanes individually, so it's excluded. */}
        {(activeLeftPanel === 'elements' || activeLeftPanel === 'drift') && (
          <SubIconBtn title={t('leftSidebar.actions.collapseAll')} onClick={collapseAll}>
            <Minus size={11} strokeWidth={1.6} />
          </SubIconBtn>
        )}
        <SubIconBtn
          title={t('leftSidebar.actions.sort')}
          onClick={() => setSortMenuOpen((v) => !v)}
          buttonRef={sortBtnRef}
          expanded={sortMenuOpen}
        >
          <ArrowDownUp size={11} strokeWidth={1.6} />
        </SubIconBtn>
        {renderSecondaryCreate()}
        {renderPrimaryCreate()}
      </div>

      {/* One SortMenu instance per panel kind — keeps each menu's typed
          value/onChange aligned with the matching ui-store field. Only the
          active panel's instance is rendered open at a time. */}
      {activeLeftPanel === 'drift' && (
        <SortMenu<DriftSortMode>
          triggerRef={sortBtnRef}
          open={sortMenuOpen}
          onClose={() => setSortMenuOpen(false)}
          options={driftSortOptions}
          value={driftSortMode}
          onChange={setDriftSortMode}
          title={sortMenuTitle}
          groups={[
            sortMenuGroup({
              title: t('leftSidebar.sort.cellMetaGroup'),
              options: nodeCellMetaOptions,
              value: driftCellMeta,
              onChange: setDriftCellMeta,
            }),
          ]}
        />
      )}
      {activeLeftPanel === 'nodes' && !chapterIsStoryline && (
        <SortMenu<ChapterGlobalSortMode>
          triggerRef={sortBtnRef}
          open={sortMenuOpen}
          onClose={() => setSortMenuOpen(false)}
          options={chapterGlobalSortOptions}
          value={chapterGlobalSortMode}
          onChange={setChapterGlobalSortMode}
          title={sortMenuTitle}
          groups={[
            sortMenuGroup({
              title: t('leftSidebar.sort.cellMetaGroup'),
              options: nodeCellMetaOptions,
              value: chapterCellMeta,
              onChange: setChapterCellMeta,
            }),
          ]}
        />
      )}
      {activeLeftPanel === 'nodes' && chapterIsStoryline && (
        <SortMenu<ChapterStorylineInnerSortMode>
          triggerRef={sortBtnRef}
          open={sortMenuOpen}
          onClose={() => setSortMenuOpen(false)}
          options={chapterStorylineInnerSortOptions}
          value={chapterStorylineInnerSortMode}
          onChange={setChapterStorylineInnerSortMode}
          title={sortMenuTitle}
          groups={[
            sortMenuGroup({
              title: t('leftSidebar.sort.duplicatesGroup'),
              options: chapterDuplicateOptions,
              value: chapterStorylinePrimaryOnly ? 'primary' : 'all',
              onChange: (v) => setChapterStorylinePrimaryOnly(v === 'primary'),
            }),
            sortMenuGroup({
              title: t('leftSidebar.sort.cellMetaGroup'),
              options: nodeCellMetaOptions,
              value: chapterCellMeta,
              onChange: setChapterCellMeta,
            }),
          ]}
        />
      )}
      {activeLeftPanel === 'elements' && (
        <SortMenu<ElementSortMode>
          triggerRef={sortBtnRef}
          open={sortMenuOpen}
          onClose={() => setSortMenuOpen(false)}
          options={elementSortOptions}
          value={elementSortMode}
          onChange={setElementSortMode}
          title={sortMenuTitle}
        />
      )}
    </div>
  );
}

function SubIconBtn({
  title,
  onClick,
  children,
  accent,
  disabled,
  buttonRef,
  expanded,
}: {
  title: string;
  onClick?: () => void;
  children: React.ReactNode;
  accent?: boolean;
  disabled?: boolean;
  buttonRef?: React.Ref<HTMLButtonElement>;
  expanded?: boolean;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      title={title}
      aria-label={title}
      aria-expanded={expanded}
      aria-haspopup={expanded === undefined ? undefined : 'menu'}
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

/**
 * Compact view-mode toggle for the 章节 panel — off = 全书总览 (flat chapter
 * list), on = 按 storyline 分组 (storyline lanes). Sized down to sit inline with
 * the tiny subheader meta text; mirrors the settings `.tog` switch in shape.
 */
function ViewModeSwitch({
  on,
  onToggle,
  titleOn,
  titleOff,
}: {
  on: boolean;
  onToggle: () => void;
  titleOn: string;
  titleOff: string;
}) {
  return (
    <Switch size="sm" checked={on} onCheckedChange={onToggle} title={on ? titleOn : titleOff} />
  );
}
