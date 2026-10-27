import { revealDesktopAgentView } from '../../store/desktop-agent-navigation';
import { useCallback, useMemo, type ReactNode } from 'react';
import { useSidebarPanelScroll } from '../../hooks/useSidebarPanelState';
import { useTranslation } from 'react-i18next';
import { useDataStoreFields } from '../../store/use-data-store-fields';
import { isDrift } from '../../domain/book-node';
import { useUiStore, useProjectTabs, focusedLeafOf, tabKey, usePromoteCurrentTab } from '../../store/ui-store';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { RightSidebarHeader, RightSidebarTitle } from '../../components/rightBars/RightSidebarHeader';
import { DesktopSidebarLayout } from './DesktopSidebarLayout';
import { LibraryPanel, type FocusedEntity } from '../../features/library/LibraryPanel';
import { ReviewPanel } from '../../components/rightBars/ReviewPanel';
import { DesktopAgentPanel } from '../../features/agent/desktop/DesktopAgentPanel';
import type { EntityKind } from '../../lib/extensions/entity-link';
import { EntityStatsContent } from '../../features/stats/EntityStatsContent';
import type { EntityStatsTarget } from '../../features/stats/entity-stats-types';

export function DesktopRightSidebar() {
  const { t } = useTranslation();
  const { projectId, openEntity } = useProjectNavigation();
  const promoteCurrentTab = usePromoteCurrentTab(projectId);
  const pinLibraryItem = useCallback(
    (libraryItemId: string) => {
      openEntity({ entityType: 'library_item', id: libraryItemId });
      promoteCurrentTab();
    },
    [openEntity, promoteCurrentTab],
  );
  const { activeTabKey, openTabs } = useProjectTabs(projectId);
  const panes = useUiStore((s) => s.desktopSidebarTabs.right.panes);
  const setActiveSuperView = useUiStore((s) => s.setActiveSuperView);
  const openMaterialWorkbench = useCallback(() => setActiveSuperView('memo-material'), [setActiveSuperView]);

  const {
    bookNodes,
    bookActs,
    bookElements,
    storylines,
    bookElementCategories,
    storylineNodeMapping,
    primaryStorylineByNode,
    libraryItems,
  } = useDataStoreFields(
    'bookNodes',
    'bookActs',
    'bookElements',
    'storylines',
    'bookElementCategories',
    'storylineNodeMapping',
    'primaryStorylineByNode',
    'libraryItems',
  );

  // Decode the active tab into a resolved target so the right panel can show
  // entity-specific context. Falls back to "no target" on the project home.
  const target = useMemo<EntityStatsTarget>(() => {
    // Per the focused-only selection model, the right sidebar tracks the
    // focused side of the active tab regardless of whether it's a single
    // leaf or a split. The non-focused half of a split doesn't reflect here.
    const activeTab = openTabs.find((t) => tabKey(t) === activeTabKey);
    if (!activeTab) {
      return {
        kind: 'none',
        id: null,
        title: t('rightSidebar.targets.dashboard'),
        kicker: t('rightSidebar.kickers.dashboard'),
      };
    }
    const leaf = focusedLeafOf(activeTab);
    if (!leaf) {
      return { kind: 'none', id: null, title: '—', kicker: t('rightSidebar.kickers.noTab') };
    }
    if (leaf.entityType === 'all-chapters') {
      // kicker only surfaces in the stats tab (library/review use hardcoded
      // project-wide kickers), so phrase it for the aggregate stats view.
      return {
        kind: 'all-chapters',
        id: null,
        title: t('rightSidebar.targets.allChapters'),
        kicker: t('rightSidebar.kickers.allChapters'),
      };
    }
    if (leaf.entityType === 'node') {
      const node = bookNodes.find((n) => n.id === leaf.id);
      if (!node) return { kind: 'none', id: leaf.id, title: '—', kicker: '—' };
      const drift = isDrift(node);
      const primaryId = primaryStorylineByNode[node.id] ?? null;
      const storyline = primaryId ? storylines.find((s) => s.id === primaryId) : undefined;
      return {
        kind: drift ? 'drift' : 'chapter',
        id: node.id,
        title:
          node.title ||
          (drift ? t('topTimeline.untitled.drift') : t('topTimeline.untitled.chapter')),
        kicker: drift
          ? t('rightSidebar.kickers.driftContent')
          : t('rightSidebar.kickers.chapterContent'),
        color: storyline?.color,
      };
    }
    if (leaf.entityType === 'storyline') {
      const s = storylines.find((sl) => sl.id === leaf.id);
      return {
        kind: 'storyline',
        id: leaf.id,
        title: s?.name || t('topTimeline.untitled.storyline'),
        kicker: t('rightSidebar.kickers.storylineContent'),
        color: s?.color,
      };
    }
    if (leaf.entityType === 'element') {
      const e = bookElements.find((el) => el.id === leaf.id);
      const cat = e ? bookElementCategories.find((c) => c.id === e.categoryId) : undefined;
      return {
        kind: 'element',
        id: leaf.id,
        title: e?.name || t('topTimeline.untitled.element'),
        kicker: t('rightSidebar.kickers.elementContent'),
        color: cat?.color,
      };
    }
    if (leaf.entityType === 'category') {
      const c = bookElementCategories.find((cat) => cat.id === leaf.id);
      return {
        kind: 'category',
        id: leaf.id,
        title: c?.name || leaf.id,
        kicker: t('rightSidebar.kickers.categoryContent'),
        color: c?.color,
      };
    }
    if (leaf.entityType === 'library_item') {
      const item = libraryItems.find((candidate) => candidate.id === leaf.id);
      return {
        kind: 'material',
        id: leaf.id,
        title: item?.title || t('topTimeline.untitled.library_item'),
        kicker: t('rightSidebar.kickers.materialContent'),
      };
    }
    return { kind: 'none', id: null, title: '—', kicker: '—' };
  }, [
    libraryItems,
    activeTabKey,
    openTabs,
    bookNodes,
    bookElements,
    storylines,
    bookElementCategories,
    primaryStorylineByNode,
    t,
  ]);

  const focusedForPanel: FocusedEntity = useMemo(() => {
    if (!target.kind || target.kind === 'none' || !target.id) {
      return { kind: null, id: null };
    }
    const kindMap: Record<string, EntityKind | null> = {
      chapter: 'node',
      drift: 'node',
      storyline: 'storyline',
      element: 'element',
      category: 'category',
    };
    const kind = kindMap[target.kind] ?? null;
    return { kind, id: target.id };
  }, [target.kind, target.id]);
  // Review follows a material tab to its region comments; the library list has
  // no "related to this material" relation to filter by.
  const focusedMaterialId = useMemo(() => {
    const activeTab = openTabs.find((tab) => tabKey(tab) === activeTabKey);
    const leaf = activeTab ? focusedLeafOf(activeTab) : null;
    return leaf?.entityType === 'library_item' ? leaf.id : null;
  }, [activeTabKey, openTabs]);
  const focusedForReview: FocusedEntity = useMemo(
    () => (focusedMaterialId ? { kind: 'library_item', id: focusedMaterialId } : focusedForPanel),
    [focusedForPanel, focusedMaterialId],
  );
  return (
    <DesktopSidebarLayout
      side="right"
      projectId={projectId}
      panels={panes.map(({ id, tab }, index) => ({
        id,
        tab,
        header: <RightSidebarHeader paneId={id} activeTab={tab} windowChrome={index === panes.length - 1} />,
        content: <>
          {tab === 'stats' && <RightSidebarTitle
            kicker={t(`rightSidebar.kickers.stats.${target.kind}`, {
              defaultValue: t('rightSidebar.kickers.stats.none'),
            })}
            title={target.title}
          />}
          <SidebarPanelBody>
            {tab === 'review' && <ReviewPanel focused={focusedForReview} onOpenAgentTask={() => revealDesktopAgentView()} />}
            {tab === 'library' && <LibraryPanel focused={focusedForPanel} activeLibraryItemId={focusedMaterialId} onPinLibraryItem={pinLibraryItem} onOpenWorkbench={openMaterialWorkbench} />}
            {tab === 'stats' && <EntityStatsContent
              target={target}
              bookNodes={bookNodes}
              bookActs={bookActs}
              bookElements={bookElements}
              storylines={storylines}
              categories={bookElementCategories}
              storylineNodeMapping={storylineNodeMapping}
              primaryStorylineByNode={primaryStorylineByNode}
            />}
            {tab === 'companion' && <DesktopAgentPanel projectId={projectId} />}
          </SidebarPanelBody>
        </>,
      }))}
    />
  );
}

function SidebarPanelBody({ children }: { children: ReactNode }) {
  const scroll = useSidebarPanelScroll();
  return <div {...scroll} className="scroll-no-bar" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>{children}</div>;
}
