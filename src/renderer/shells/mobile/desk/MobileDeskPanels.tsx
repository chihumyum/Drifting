import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';
import type { EntityKind } from '../../../lib/extensions/entity-link';
import { SidebarEditorSelectionContext } from '../../../hooks/useSidebarPanelState';
import { PanelTab, PanelTabLabel, PanelTabTray } from '../../../components/ui/PanelTabs';
import { GhostIconButton } from '../../../components/ui/GhostIconButton';
import { BrushIcon } from '../../../components/ui/BrushIcon';
import { LeftSidebarSubHeader } from '../../../components/leftBars/LeftSidebarSubHeader';
import { ChapterPanel } from '../../../components/leftBars/ChapterPanel';
import { ElementPanel } from '../../../components/leftBars/ElementPanel';
import { DriftPanel } from '../../../components/leftBars/DriftPanel';
import { WorkspaceAccountCell } from '../../../components/workspaceChrome/WorkspaceAccountControls';
import { ReviewPanel } from '../../../components/rightBars/ReviewPanel';
import { LibraryPanel, type FocusedEntity } from '../../../features/library/LibraryPanel';
import { DesktopAgentPanel } from '../../../features/agent/desktop/DesktopAgentPanel';
import { MobilePaperStats } from '../workspace/MobilePaperStats';
import { SidebarPaneContext } from '../../../lib/sidebar-pane-context';
import { useAgentPaneId } from '../../../components/workspaceChrome/workspace-intents';
import {
  MOBILE_LEFT_PANELS,
  MOBILE_RIGHT_PANELS,
  type MobileLeftPanel,
  type MobileRightPanel,
} from './mobile-desk-controller';

/** A swipe along a desk's tab row this far pushes the neighbouring panel in. */
const TAB_SWIPE_PX = 44;

function focusedEntity(target: WorkspaceTarget | null): FocusedEntity {
  if (!target || target.entityType === 'all-chapters') return { kind: null, id: null };
  return { kind: target.entityType as EntityKind, id: target.id };
}

/**
 * The panels of one desk side by side on a band that is pushed along like a
 * block of ice (docs/design-system/motion.md, 重冰推进): the chosen panel's
 * neighbours wait off either edge. A panel mounts the first time it is shown
 * and keeps its scroll and state after that.
 */
function PanelBand<T extends string>({ panels, current, render }: {
  panels: readonly T[];
  current: T;
  render: (panel: T) => ReactNode;
}) {
  const [visited, setVisited] = useState<ReadonlySet<T>>(() => new Set([current]));
  useEffect(() => {
    setVisited((set) => (set.has(current) ? set : new Set([...set, current])));
  }, [current]);
  const index = Math.max(0, panels.indexOf(current));
  return (
    <div className="m-desk-band" style={{ '--band-index': index, '--band-count': panels.length } as CSSProperties}>
      {panels.map((panel) => (
        <section key={panel} className="m-desk-band__panel" data-panel={panel} aria-hidden={panel !== current || undefined} inert={panel !== current || undefined}>
          {visited.has(panel) ? render(panel) : null}
        </section>
      ))}
    </div>
  );
}

/** A desk's tab row: words on one sliding glass block; a swipe along it changes panel. */
function DeskTabs<T extends string>({ panels, current, label, onChange, leading, trailing }: {
  panels: readonly T[];
  current: T;
  label: (panel: T) => string;
  onChange: (panel: T) => void;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  const swipe = useRef<{ id: number; x: number } | null>(null);
  const onPointerDown = (event: ReactPointerEvent) => { swipe.current = { id: event.pointerId, x: event.clientX }; };
  const onPointerUp = (event: ReactPointerEvent) => {
    const start = swipe.current;
    swipe.current = null;
    if (!start || start.id !== event.pointerId) return;
    const dx = event.clientX - start.x;
    if (Math.abs(dx) < TAB_SWIPE_PX) return;
    const index = panels.indexOf(current) + (dx < 0 ? 1 : -1);
    const next = panels[index];
    if (next) onChange(next);
  };
  return (
    <header className="m-desk__tabs" onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={() => { swipe.current = null; }}>
      {leading}
      <PanelTabTray className="m-desk__tab-tray">
        {panels.map((panel) => (
          <PanelTab key={panel} typography="label" active={panel === current} data-debug-id={`mobile-desk-tab-${panel}`} onClick={() => onChange(panel)}>
            <PanelTabLabel>{label(panel)}</PanelTabLabel>
          </PanelTab>
        ))}
      </PanelTabTray>
      {trailing}
    </header>
  );
}

/**
 * The left desk under the paper: the book's structure. Its tab row starts
 * with the way back to the shelf, where the desktop keeps the window's close
 * button, and ends with search; the account cell stands at its foot as on
 * the desktop.
 */
export function MobileLeftDesk({ panel, target, onPanelChange, onLeaveBook, onSearch, onOpenTrash }: {
  panel: MobileLeftPanel;
  target: WorkspaceTarget | null;
  onPanelChange: (panel: MobileLeftPanel) => void;
  onLeaveBook: () => void;
  onSearch: () => void;
  /** The book's own trash: what was deleted from it, to restore or empty. */
  onOpenTrash: () => void;
}) {
  const { t } = useTranslation();
  const labels: Record<MobileLeftPanel, string> = {
    nodes: t('leftSidebar.tabs.chapters'),
    elements: t('leftSidebar.tabs.elements'),
    drift: t('leftSidebar.tabs.drifts'),
  };
  const selectionFor = (candidate: MobileLeftPanel): WorkspaceTarget | null => {
    if (!target) return null;
    if (candidate === 'elements') return target.entityType === 'element' || target.entityType === 'category' ? target : null;
    return target.entityType === 'node' || target.entityType === 'storyline' ? target : null;
  };
  return (
    <div className="m-desk m-desk--left" data-debug-id="mobile-left-desk">
      <DeskTabs
        panels={MOBILE_LEFT_PANELS}
        current={panel}
        label={(candidate) => labels[candidate]}
        onChange={onPanelChange}
        leading={
          <GhostIconButton
            glass="round"
            className="m-desk__corner glass--rest"
            data-debug-id="mobile-leave-book"
            aria-label={t('mobileDesk.desk.shelf')}
            icon={<BrushIcon name="books" />}
            onClick={onLeaveBook}
          />
        }
        trailing={
          <GhostIconButton
            glass="round"
            className="m-desk__corner glass--rest"
            data-debug-id="mobile-search"
            aria-label={t('mobileWorkspace.search.projectScope')}
            icon={<BrushIcon name="search" />}
            onClick={onSearch}
          />
        }
      />
      <PanelBand
        panels={MOBILE_LEFT_PANELS}
        current={panel}
        render={(candidate) => (
          <SidebarEditorSelectionContext.Provider value={selectionFor(candidate)}>
            <div className="m-desk__panel">
              <LeftSidebarSubHeader panel={candidate} />
              <div className="m-desk__panel-body">
                {candidate === 'elements' ? <ElementPanel /> : candidate === 'drift' ? <DriftPanel /> : <ChapterPanel />}
              </div>
            </div>
          </SidebarEditorSelectionContext.Provider>
        )}
      />
      <div className="m-desk__foot">
        <WorkspaceAccountCell />
        <GhostIconButton
          glass="round"
          className="m-desk__trash glass--rest"
          data-debug-id="mobile-project-trash"
          aria-label={t('mobileDesk.desk.trash')}
          icon={<BrushIcon name="trash" />}
          onClick={onOpenTrash}
        />
      </div>
    </div>
  );
}

/**
 * The right desk under the paper: what goes with the page in front. Review,
 * the library and the stats follow it; the Agent keeps its own conversation.
 */
export function MobileRightSidebar({ projectId, panel, target, onPanelChange, onOpenWorkbench }: {
  projectId: string;
  panel: MobileRightPanel;
  target: WorkspaceTarget | null;
  onPanelChange: (panel: MobileRightPanel) => void;
  onOpenWorkbench: () => void;
}) {
  const { t } = useTranslation();
  const agentPane = useAgentPaneId();
  const focused = focusedEntity(target);
  const materialId = target?.entityType === 'library_item' ? target.id : null;
  const labels: Record<MobileRightPanel, string> = {
    review: t('rightSidebar.tabs.review'),
    library: t('rightSidebar.tabs.library'),
    stats: t('rightSidebar.tabs.stats'),
    companion: t('rightSidebar.tabs.companion'),
  };
  return (
    <div className="m-desk m-desk--right" data-debug-id="mobile-right-desk">
      <DeskTabs
        panels={MOBILE_RIGHT_PANELS}
        current={panel}
        label={(candidate) => labels[candidate]}
        onChange={onPanelChange}
      />
      <PanelBand
        panels={MOBILE_RIGHT_PANELS}
        current={panel}
        render={(candidate) => (
          <div className={`m-desk__panel m-desk__panel--${candidate}`}>
            {candidate === 'review' && (
              <div className="m-desk__panel-body">
                <ReviewPanel
                  focused={materialId ? { kind: 'library_item', id: materialId } : focused}
                  onOpenAgentTask={() => onPanelChange('companion')}
                  onOpenWorkbench={onOpenWorkbench}
                />
              </div>
            )}
            {candidate === 'library' && (
              <div className="m-desk__panel-body">
                <LibraryPanel focused={focused} activeLibraryItemId={materialId} onOpenWorkbench={onOpenWorkbench} />
              </div>
            )}
            {candidate === 'stats' && (
              <div className="m-desk__panel-body">
                {target ? <MobilePaperStats target={target} /> : null}
              </div>
            )}
            {candidate === 'companion' && (
              <SidebarPaneContext.Provider value={agentPane}>
                <DesktopAgentPanel projectId={projectId} />
              </SidebarPaneContext.Provider>
            )}
          </div>
        )}
      />
    </div>
  );
}
