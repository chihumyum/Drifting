import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDataStoreFields } from '../../store/use-data-store-fields';
import { isDrift } from '../../domain/book-node';
import { useUiStore, useProjectTabs, focusedLeafOf, tabKey } from '../../store/ui-store';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { RightSidebarHeader } from '../../components/rightBars/RightSidebarHeader';
import { LibraryPanel, type FocusedEntity } from '../../features/library/LibraryPanel';
import { ReviewPanel } from '../../components/rightBars/ReviewPanel';
import { DesktopAgentPanel } from '../../features/agent/desktop/DesktopAgentPanel';
import type { EntityKind } from '../../lib/extensions/entity-link';
import { EntityStatsContent } from '../../features/stats/EntityStatsContent';
import type { EntityStatsTarget } from '../../features/stats/entity-stats-types';

export function DesktopRightSidebar() {
  const { t } = useTranslation();
  const { projectId } = useProjectNavigation();
  const { activeTabKey, openTabs } = useProjectTabs(projectId);
  const rightPanelGroup = useUiStore((s) => s.rightPanelGroup);
  const activeRightPanel = useUiStore((s) => s.activeRightPanel);
  const splitRatio = useUiStore((s) => s.rightPanelSplitRatio);
  const setSplitRatio = useUiStore((s) => s.setRightPanelSplitRatio);

  const {
    bookNodes,
    bookActs,
    bookElements,
    storylines,
    bookElementCategories,
    storylineNodeMapping,
    primaryStorylineByNode,
  } = useDataStoreFields(
    'bookNodes',
    'bookActs',
    'bookElements',
    'storylines',
    'bookElementCategories',
    'storylineNodeMapping',
    'primaryStorylineByNode',
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
    return { kind: 'none', id: null, title: '—', kicker: '—' };
  }, [
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
  const [fragmentCountFlash] = useState(false);

  const isAgentGroup = rightPanelGroup === 'agent';
  const isFragmentTab =
    !isAgentGroup && (activeRightPanel === 'review' || activeRightPanel === 'library');
  // Agent panels render their own headers, so hide the kicker/title block there.
  const hideTitleBlock = isAgentGroup || isFragmentTab;
  const headerKicker = isAgentGroup
    ? ''
    : activeRightPanel === 'stats'
      ? t(`rightSidebar.kickers.stats.${target.kind}`, {
          defaultValue: t('rightSidebar.kickers.stats.none'),
        })
      : activeRightPanel === 'review'
        ? t('rightSidebar.kickers.review')
        : t('rightSidebar.kickers.library');
  const headerTitle = isAgentGroup
    ? ''
    : activeRightPanel === 'review'
      ? t('rightSidebar.tabs.review')
      : activeRightPanel === 'library'
        ? t('rightSidebar.tabs.library')
        : target.title;

  // Wide right panel → show both groups side by side. Triggered by the panel's
  // own rendered width (not the screen width). Below the threshold it collapses
  // back to a single column + the group switch.
  const rootRef = useRef<HTMLDivElement>(null);
  const [panelWidth, setPanelWidth] = useState(Number.POSITIVE_INFINITY);
  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const update = () => setPanelWidth(node.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);
  const isSplit = panelWidth >= 600;
  // Whenever the panel isn't wide enough to split into two columns it stays a
  // single column with all four tabs laid flat in one row — no group switch.
  // The tab labels compact down as the tray tightens (see RightSidebarHeader),
  // so this holds together all the way down to the 200px min width.

  // Drag the divider between the two columns to reallocate width. Mirrors the
  // editor split-pane divider (EditorMainArea/SplitView): ref-tracked rect so
  // the move listener never reads a stale closure, and the store setter clamps
  // the ratio to keep both columns usable. The ratio persists via the store.
  const draggingRef = useRef(false);
  const onDividerMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      draggingRef.current = true;
      const onMove = (e: MouseEvent) => {
        if (!draggingRef.current) return;
        const el = rootRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0) return;
        setSplitRatio((e.clientX - rect.left) / rect.width);
      };
      const onUp = () => {
        draggingRef.current = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [setSplitRatio],
  );
  const leftColWidth = `${Math.round(splitRatio * 100)}%`;
  const rightColWidth = `${100 - Math.round(splitRatio * 100)}%`;

  const contentBody = (
    <>
      {activeRightPanel === 'review' && <ReviewPanel focused={focusedForPanel} />}
      {activeRightPanel === 'library' && <LibraryPanel focused={focusedForPanel} />}
      {activeRightPanel === 'stats' && (
        <EntityStatsContent
          target={target}
          bookNodes={bookNodes}
          bookActs={bookActs}
          bookElements={bookElements}
          storylines={storylines}
          categories={bookElementCategories}
          storylineNodeMapping={storylineNodeMapping}
          primaryStorylineByNode={primaryStorylineByNode}
        />
      )}
    </>
  );
  const agentBody = <DesktopAgentPanel projectId={projectId} />;

  return (
    <div
      ref={rootRef}
      style={{
        display: 'flex',
        flexDirection: isSplit ? 'row' : 'column',
        height: '100%',
        minHeight: 0,
        background: 'var(--workspace-ui-bg)',
      }}
    >
      {isSplit ? (
        <>
          <div
            style={{
              width: leftColWidth,
              minWidth: 0,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <RightSidebarHeader group="content" kicker="" title="" hideTitleBlock />
            <div className="scroll-no-bar" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
              {contentBody}
            </div>
          </div>
          <ColumnDivider onMouseDown={onDividerMouseDown} />
          <div
            style={{
              width: rightColWidth,
              minWidth: 0,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <RightSidebarHeader group="agent" kicker="" title="" hideTitleBlock />
            <div className="scroll-no-bar" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
              {agentBody}
            </div>
          </div>
        </>
      ) : (
        <>
          <RightSidebarHeader
            flat
            kicker={headerKicker}
            title={headerTitle}
            fragmentCountFlash={fragmentCountFlash}
            hideTitleBlock={hideTitleBlock}
          />
          <div className="scroll-no-bar" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            {rightPanelGroup === 'content' ? contentBody : agentBody}
          </div>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats (per-entity)

function ColumnDivider({
  onMouseDown,
}: {
  onMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation="vertical"
      style={{
        width: 7,
        marginLeft: -3,
        marginRight: -3,
        flexShrink: 0,
        position: 'relative',
        zIndex: 1,
        cursor: 'col-resize',
        display: 'flex',
        justifyContent: 'center',
        background: 'transparent',
      }}
    >
      <div
        style={{ width: 0.5, height: '100%', background: 'var(--workspace-local-border)' }}
      />
    </div>
  );
}
