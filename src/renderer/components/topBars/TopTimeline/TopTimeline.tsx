import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useDataStore } from '../../../store/data-store';
import { createTopTabPresentationSelector, leafPresentationKey } from './top-tab-presentation';
import { BrushIcon } from '../../ui/BrushIcon';
import { KindMark } from '../../ui/KindMark';
import { kindMarkOfTarget, type KindMarkKind } from '../../ui/kind-mark';
import { useTabReorder } from './useTabReorder';
import { useProjectNavigation } from '../../../hooks/useProjectNavigation';
import {
  useUiStore,
  useProjectTabs,
  tabKey,
  focusedLeafOf,
  type AnyTab,
  type LeafTab,
  type SplitTab,
  type TabEntityType,
} from '../../../store/ui-store';
import { isProjectHomePathname } from '../../../features/workspace/navigation/workspace-route';
import { useDesktopTabClose } from '../../../shells/desktop/navigation/DesktopTabCloseContext';
import { useGlassWave } from '../../../hooks/useGlassWave';
import { captureDock, createDockLeaveState, playDockLeave, stopDockLeave, type DockSnapshot } from './dock-leave';

// Floor: absolute survival width — chrome (icon + close) just fits, label
// area collapses. Tabs may dip below this only if their idealW is naturally
// smaller (which can't happen since idealW ≥ chrome).
const TAB_FLOOR_WIDTH = 56;
// Min: the *readable* threshold. When proportional shrink would push the
// longest tab below this, the virtual canvas doubles and tabs spread out
// again — the bar grows wider (overflowX:auto scrolls), but each tab stays
// readable.
const TAB_MIN_WIDTH = 120;
// Max: per-tab cap so a runaway title doesn't dominate the bar in Phase A.
const TAB_MAX_WIDTH = 320;
// 0: reorder geometry treats slots as contiguous. Expanded pills draw their
// glass inset inside the slot, so the visible gap lives inside each slot.
const TAB_GAP = 0;
// The lock before the pills and the create button after them stay put while
// the pills scroll; each takes a round glass button (`--glass-round-size`,
// materials.css) and a 5px gap.
const DOCK_ROUND_GLASS_SIZE = 28;
const TAB_STRIP_START_PADDING = DOCK_ROUND_GLASS_SIZE + 5;
const TAB_STRIP_END_PADDING = DOCK_ROUND_GLASS_SIZE + 5;
// A split slot carries two sub-labels and reads as ~1.6 leaf tabs wide.
const SPLIT_WEIGHT = 1.6;

// Hidden DOM span used to measure label widths in the *actual* rendered font.
// canvas measureText can't resolve `var(--font-sans)` and silently falls back
// to a different system font — the resulting under/over-estimate is what was
// causing tabs to truncate labels even in Phase A.
const labelMeasureEl: HTMLSpanElement | null = (() => {
  if (typeof document === 'undefined') return null;
  const span = document.createElement('span');
  span.style.cssText = [
    'position:absolute',
    'visibility:hidden',
    'pointer-events:none',
    'top:-9999px',
    'left:-9999px',
    'white-space:nowrap',
    'font-family:var(--font-sans), -apple-system, BlinkMacSystemFont, sans-serif',
    'font-size:var(--ui-font-body, 12.5px)',
    'font-weight:400',
    'letter-spacing:-0.005em',
  ].join(';');
  document.body.appendChild(span);
  return span;
})();

function measureLabelWidth(text: string, fontSize: number): number {
  if (!labelMeasureEl) return Math.ceil(text.length * fontSize);
  labelMeasureEl.textContent = text;
  return Math.ceil(labelMeasureEl.getBoundingClientRect().width);
}

// Chrome layout on a leaf tab:
//   paddingL 10 + mark 14 + gap 6 + label + gap 6 + closeMargin 2 + close 16 + paddingR 6
// The kind mark leads the title in the flow; the dot's sand that spreads
// away under the glass sits out of the flow on the same spot.
const TAB_CHROME_WIDTH = 10 + 14 + 6 + 6 + 2 + 16 + 6;
// Split tab = two SplitSubLabel slots around a short I-shaped divider. Each sub-label:
//   paddingL 8 + mark 14 + gap 5 + label + gap 5 + close 14 + paddingR 6 = 52 + label
// Total chrome = 52 + 52 + 9 (divider 1 + its margins) = 113.
const SPLIT_CHROME_WIDTH = 52 + 52 + 9;


/**
 * The workspace's open documents, docked along the paper's top. At rest every
 * tab is the sand mark of its kind in its entity colour (hollow while still a
 * preview); while hovered or focused glass lands on the marks: each grows
 * into a pill whose rim takes the mark's colour, its sand spreading away
 * under the glass. The lock (`leading`) and the create button stay put while
 * the pills scroll.
 */
export function TopTimeline({ expanded = true, leading }: {
  expanded?: boolean;
  /** Rendered before the pills while expanded, outside their overflow. */
  leading?: ReactNode;
} = {}) {
  const { t } = useTranslation();
  const location = useLocation();
  const { projectId, openEntity, activateLeafTab, navigateToHome } = useProjectNavigation();
  const { openTabs, activeTabKey } = useProjectTabs(projectId);
  // Home has no pill: while it shows, the + is lit, since creating lives there.
  const homeShowing = useUiStore((s) => s.activeSuperView === 'none')
    && isProjectHomePathname(projectId, location.pathname);
  const closeWorkspaceTab = useDesktopTabClose();
  const closeSplitSide = useUiStore((s) => s.closeSplitSide);
  const promoteTab = useUiStore((s) => s.promoteTab);
  const selectPresentation = useMemo(() => createTopTabPresentationSelector(projectId, openTabs), [projectId, openTabs]);
  const presentation = useDataStore(selectPresentation);
  const tabKeys = useMemo(() => openTabs.map(tabKey), [openTabs]);

  // The active tab paints its own static rectangular state. The container ref
  // remains the authority for width allocation, drag/drop and scrolling.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [labelFontSize, setLabelFontSize] = useState(14);
  // Pills have no hover card: a tab is split by dragging it onto the left or
  // right half of the paper; the split's own operations live on the editors'
  // seam (EditorMainArea).

  // The strip hugs its tabs so it can sit centred under the paper; the dock
  // around it owns the width the tabs may share.
  useEffect(() => {
    const el = containerRef.current?.parentElement;
    if (!el) return;
    const update = () => setContainerWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);


  // The portaled probe inherits the same desktop token as visible tabs.
  // Recalculate after a text-size preference change even
  // when the tab strip itself has not changed width.
  useEffect(() => {
    if (!labelMeasureEl) return;
    const update = () => setLabelFontSize(parseFloat(getComputedStyle(labelMeasureEl).fontSize));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(labelMeasureEl);
    return () => observer.disconnect();
  }, []);

  const labelOfLeaf = useCallback((leaf: LeafTab): string => {
    const label = presentation.labels.get(leafPresentationKey(leaf));
    if (label?.title) return label.title;
    return label?.fallback === 'all-chapters'
      ? t('topTimeline.singletons.allChapters')
      : t(`topTimeline.untitled.${label?.fallback ?? 'chapter'}`);
  }, [presentation.labels, t]);
  const colorOfLeaf = useCallback((leaf: LeafTab) => presentation.appearances.get(leafPresentationKey(leaf))?.color,
    [presentation.appearances]);
  const isDriftLeaf = useCallback((leaf: LeafTab) => presentation.appearances.get(leafPresentationKey(leaf))?.isDrift ?? false,
    [presentation.appearances]);
  // Dots of one kind sit together; a wider seam marks where the kind changes.
  const clusterOf = useCallback((tab: AnyTab) => {
    if (tab.kind !== 'leaf') return tab.kind;
    return tab.entityType === 'node' && isDriftLeaf(tab) ? 'drift' : tab.entityType;
  }, [isDriftLeaf]);

  // Three-phase tab sizing:
  //
  //   A. Plenty of space (idealTotal ≤ availableW)
  //      Each tab is exactly its ideal width — label + chrome, capped at MAX
  //      to keep one long title from dominating. Empty space hangs off the
  //      right end.
  //
  //   B. Cramped (idealTotal > availableW)
  //      Tabs shrink proportionally by a single scale factor, so every tab
  //      keeps its share of the bar relative to its title length. Short tabs
  //      stay smaller than long ones.
  //
  //   C. Virtual canvas expansion
  //      If the scale in B would push the longest tab below TAB_MIN_WIDTH
  //      (readable threshold), the virtual canvas doubles (visible × 2, × 4,
  //      …) until the longest tab is back at or above MIN. The bar then
  //      exceeds visible width and overflowX:auto on the container lets the
  //      user scroll. This trades scroll distance for readability — exactly
  //      the spec'd behavior.
  //
  // Splits count as SPLIT_WEIGHT leaf-units throughout (for ideal width and
  // for the MIN/FLOOR clamps), so a fused tab gets ~1.6× the space.
  const tabWidths = useMemo(() => {
    if (openTabs.length === 0) return [] as number[];
    const weights = openTabs.map((t) => (t.kind === 'split' ? SPLIT_WEIGHT : 1));
    const ideals = openTabs.map((tab, i) => {
      const raw =
        tab.kind === 'leaf'
          ? measureLabelWidth(labelOfLeaf(tab), labelFontSize) + TAB_CHROME_WIDTH
          : measureLabelWidth(labelOfLeaf(tab.left), labelFontSize) +
              measureLabelWidth(labelOfLeaf(tab.right), labelFontSize) +
              SPLIT_CHROME_WIDTH;
      return Math.min(TAB_MAX_WIDTH * weights[i], raw);
    });
    const totalGaps = TAB_GAP * Math.max(0, openTabs.length - 1);
    // Preserve the document-tab sizing contract. The adjacent `+` is a
    // separate strip item and may extend the scrollable content; it must not
    // make every existing tab enter proportional shrink earlier.
    const availableW = Math.max(0, containerWidth - TAB_STRIP_START_PADDING - TAB_STRIP_END_PADDING - totalGaps);
    const idealTotal = ideals.reduce((a, b) => a + b, 0);

    // Phase A — or initial render before ResizeObserver fires.
    if (containerWidth === 0 || idealTotal <= availableW) {
      return ideals.map((w, i) => Math.max(TAB_FLOOR_WIDTH * weights[i], Math.floor(w)));
    }

    // Phase B/C — proportional shrink, expanding the virtual canvas in 2×
    // steps until the per-unit longest tab stays ≥ MIN.
    const perUnit = ideals.map((w, i) => w / weights[i]);
    const maxPerUnit = Math.max(...perUnit);
    let virtual = availableW;
    // Cap iterations: log2(32) = 5 doublings is more headroom than any
    // realistic tab count needs, and guards against degenerate inputs.
    for (let k = 0; k < 5 && (virtual / idealTotal) * maxPerUnit < TAB_MIN_WIDTH; k++) {
      virtual *= 2;
    }
    const scale = Math.min(1, virtual / idealTotal);
    return ideals.map((w, i) => Math.max(TAB_FLOOR_WIDTH * weights[i], Math.floor(w * scale)));
  }, [openTabs, labelOfLeaf, containerWidth, labelFontSize]);

  useTabReorder(containerRef, projectId, openTabs, tabWidths);
  // Choosing another pill sends the selected glass across like water.
  useGlassWave(containerRef, activeTabKey, expanded);

  // Whether the pills have been scrolled away from their start.
  const scrolled = useRef(false);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const onScroll = () => { scrolled.current = container.scrollLeft > 0; };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, [containerRef]);

  // When the active tab changes (or the layout shifts enough to push it out of
  // view), scroll the bar so the active tab is fully visible. Without this,
  // activating a tab via shortcut / split focus change / URL nav can leave the
  // active tab inside the horizontal overflow with no visual cue. Expanding
  // the dock counts too: the pills grow out of their dots (dock-pill-grow),
  // so the row only reaches its width once they have grown.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !activeTabKey) return undefined;
    const tabsWidth = tabWidths.reduce((sum, width) => sum + width, 0) + TAB_GAP * Math.max(0, tabWidths.length - 1);
    const fits = containerWidth > 0 && tabsWidth <= containerWidth - TAB_STRIP_START_PADDING - TAB_STRIP_END_PADDING;
    const reveal = () => {
      // Every pill fits and the strip sits at its start, so the active one is
      // in view. Reading offsets here would force the layout of the editor
      // tab that this same switch is revealing.
      if (fits && !scrolled.current) return;
      const activeEl = container.querySelector(
        `[data-tab-key="${CSS.escape(activeTabKey)}"]`,
      ) as HTMLElement | null;
      if (!activeEl) return;
      const left = activeEl.offsetLeft - container.scrollLeft;
      const right = left + activeEl.offsetWidth;
      if (left < 0) {
        container.scrollBy({ left: left - 8, behavior: 'auto' });
      } else if (right > container.clientWidth) {
        container.scrollBy({ left: right - container.clientWidth + 8, behavior: 'auto' });
      }
    };
    reveal();
    const grown = (event: AnimationEvent) => {
      if (event.animationName === 'dock-pill-grow') reveal();
    };
    container.addEventListener('animationend', grown);
    return () => container.removeEventListener('animationend', grown);
  }, [activeTabKey, tabWidths, containerWidth, containerRef, expanded]);

  // Tab activation uses the shell navigator rather than openEntity, which
  // preserves split/all-chapters semantics.
  const handleSelectTab = useCallback(
    (tab: AnyTab) => {
      if (!projectId) return;
      const target = focusedLeafOf(tab);
      if (target) activateLeafTab(target);
    },
    [activateLeafTab, projectId],
  );

  const handleCloseTab = useCallback(
    (tab: AnyTab) => {
      if (!projectId) return;
      closeWorkspaceTab(tab);
    },
    [projectId, closeWorkspaceTab],
  );

  const handlePromote = useCallback(
    (tab: AnyTab) => {
      if (!projectId || tab.kind === 'split' || !tab.isPreview) return;
      promoteTab(projectId, { entityType: tab.entityType, id: tab.id });
    },
    [projectId, promoteTab],
  );

  // The lock and the plus sit either side of the pills' scroller, never in
  // it: only the pills scroll, nothing floats over them, and in WebKit no
  // sticky glass inside the scroller lifts the pills into layers of their
  // own, where their flowing rims and the selection wave stop repainting.
  return (
    <>
    <DockLeaveMotion container={containerRef} tabKeys={tabKeys} expanded={expanded} />
    {expanded && leading}
    <div
      ref={containerRef}
      role="tablist"
      className={`top-timeline-container ${expanded ? 'is-expanded' : 'is-collapsed'}`}
      style={{
        display: 'flex',
        alignItems: expanded ? 'stretch' : 'center',
        gap: TAB_GAP,
        overflowX: 'auto',
        overflowY: 'hidden',
        flex: '0 1 auto',
        minWidth: 0,
        width: 'fit-content',
        maxWidth: '100%',
        paddingLeft: 0,
        paddingRight: 0,
        scrollbarWidth: 'none',
        msOverflowStyle: 'none',
        WebkitOverflowScrolling: 'touch',
        position: 'relative',
      }}
    >
      {openTabs.map((tab, index) => {
        const key = tabKey(tab);
        const isActive = key === activeTabKey;
        const width = tabWidths[index] ?? TAB_MIN_WIDTH;
        if (!expanded) {
          const clusterBreak = index > 0 && clusterOf(openTabs[index - 1]) !== clusterOf(tab);
          if (tab.kind === 'split') {
            return (
              <span key={key} role="tab" aria-selected={isActive} data-tab-key={key}
                className={`app-tab-dot-pair${isActive ? ' is-active' : ''}`}
                data-cluster-break={clusterBreak ? 'true' : undefined}>
                {(['left', 'right'] as const).map((side) => (
                  <TabDot key={side}
                    kind={kindMarkOfTarget(tab[side].entityType, isDriftLeaf(tab[side]))}
                    seed={tab[side].id}
                    label={labelOfLeaf(tab[side])}
                    color={colorOfLeaf(tab[side])}
                    isActive={isActive && tab.focused === side}
                    isPreview={tab[side].isPreview}
                    onSelect={() => activateLeafTab(tab[side])}
 />
                ))}
              </span>
            );
          }
          return (
            <TabDot key={key} tabKeyValue={key}
              kind={kindMarkOfTarget(tab.entityType, isDriftLeaf(tab))}
              seed={tab.id}
              label={labelOfLeaf(tab)}
              color={colorOfLeaf(tab)}
              isActive={isActive}
              isPreview={tab.isPreview}
              clusterBreak={clusterBreak}
              onSelect={() => handleSelectTab(tab)}
 />
          );
        }
        if (tab.kind === 'leaf') {
          return (
            <LeafTabSlot
              key={key}
              tab={tab}
              isActive={isActive}
              width={width}
              label={labelOfLeaf(tab)}
              color={colorOfLeaf(tab)}
              isDrift={isDriftLeaf(tab)}
              onSelect={() => handleSelectTab(tab)}
              onPromote={() => handlePromote(tab)}
              onClose={() => handleCloseTab(tab)}
            />
          );
        }

        return (
          <SplitTabSlot
            key={key}
            tab={tab}
            isActive={isActive}
            width={width}
            leftLabel={labelOfLeaf(tab.left)}
            rightLabel={labelOfLeaf(tab.right)}
            leftColor={colorOfLeaf(tab.left)}
            rightColor={colorOfLeaf(tab.right)}
            leftIsDrift={isDriftLeaf(tab.left)}
            rightIsDrift={isDriftLeaf(tab.right)}
            onSelectSide={(side) => {
              const leaf = side === 'left' ? tab.left : tab.right;
              activateLeafTab(leaf);
            }}
            onPromoteSide={(side) => {
              if (projectId) promoteTab(projectId, { splitId: tab.id, side });
            }}
            onCloseSide={(side) => {
              if (!projectId) return;
              const { nextActive } = closeSplitSide(projectId, tab.id, side);
              if (nextActive) openEntity({ entityType: nextActive.entityType, id: nextActive.id });
            }}
          />
        );
      })}
    </div>

    {expanded && <button
        type="button"
        className="top-timeline-create-button glass glass--rest glass--round"
        aria-label={t('topTimeline.newEntity')}
        aria-pressed={homeShowing}
        title={t('topTimeline.newEntity')}
        onClick={() => {
          if (projectId) navigateToHome({ intent: 'new' });
        }}
      >
        <BrushIcon name="plus" />
      </button>}
    </>
  );
}

/**
 * Closing a tab animates like opening one (dock-leave.ts). React removes the
 * closed pill in the same commit that moves its neighbours, so where they all
 * stood has to be read before the DOM changes: a class component's
 * getSnapshotBeforeUpdate is the one hook that runs then. After the commit
 * the closed pill folds away and the rest slide together. Changing between
 * marks and pills is a change of form, not a close, and moves nothing here.
 */
class DockLeaveMotion extends Component<{
  container: RefObject<HTMLDivElement | null>;
  tabKeys: readonly string[];
  expanded: boolean;
}> {
  private readonly motion = createDockLeaveState();

  getSnapshotBeforeUpdate(previous: Readonly<DockLeaveMotion['props']>): DockSnapshot | null {
    const container = this.props.container.current;
    if (!container || previous.expanded !== this.props.expanded || previous.tabKeys === this.props.tabKeys) return null;
    return captureDock(container, new Set(this.props.tabKeys));
  }

  componentDidUpdate(previous: Readonly<DockLeaveMotion['props']>, _state: unknown, snapshot: DockSnapshot | null) {
    if (previous.expanded !== this.props.expanded) stopDockLeave(this.motion);
    const container = this.props.container.current;
    if (snapshot && container) playDockLeave(container, snapshot, this.motion);
  }

  componentWillUnmount() {
    stopDockLeave(this.motion);
  }

  render() {
    return null;
  }
}

interface LeafSlotProps {
  tab: LeafTab;
  isActive: boolean;
  width: number;
  label: string;
  color: string | undefined;
  isDrift: boolean;
  onSelect: () => void;
  onPromote: () => void;
  onClose: () => void;
}

function LeafTabSlot({
  tab,
  isActive,
  width,
  label,
  color,
  isDrift,
  onSelect,
  onPromote,
  onClose,
}: LeafSlotProps) {
  const { t } = useTranslation();
  // Glass with no colour of its own is the clear glass, as everywhere else.
  const accent = color || 'var(--glass-clear)';
  return (
    <div
      role="tab"
      aria-selected={isActive}
      data-tab-key={tabKey(tab)}
      className={`app-tab glass glass--rest${isActive ? ' is-active is-on' : ''}`}
      draggable
      onClick={onSelect}
      onDoubleClick={onPromote}
      onMouseDown={(event) => {
        if (event.button === 1) {
          event.preventDefault();
          onClose();
        }
      }}
      style={
        {
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          paddingLeft: 10,
          paddingRight: 6,
          width,
          minWidth: TAB_FLOOR_WIDTH,
          cursor: 'pointer',
          fontFamily: 'var(--font-sans)',
          fontSize: 'var(--ui-font-body, 12.5px)',
          color: isActive ? 'hsl(var(--ink-1))' : 'hsl(var(--ink-2))',
          // A pill's glass takes the colour of the mark it grew from.
          '--glass-cc': accent,
          // Constant weight: bolding the active tab widens its glyphs, so at
          // the same fixed tab width the SELECTED label ellipsized earlier
          // than unselected ones. Emphasis comes from a metric-neutral
          // text-shadow instead.
          fontWeight: 400,
          textShadow: isActive ? '0 0 0.6px currentcolor' : 'none',
          fontStyle: tab.isPreview ? 'italic' : 'normal',
          position: 'relative',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          height: '100%',
          userSelect: 'none',
        } as React.CSSProperties
      }
    >
      {/* The dot's sand spreads out and thins away under the glass, and the
          kind mark settles in its place before the title. */}
      <span className="app-tab__sand" aria-hidden>
        <KindMark kind={kindMarkOfTarget(tab.entityType, isDrift)} seed={tab.id} color={color} />
      </span>
      <KindMark className="app-tab__mark" kind={kindMarkOfTarget(tab.entityType, isDrift)}
        seed={tab.id} color={color} hollow={tab.isPreview} />
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0,
          flex: 1,
          letterSpacing: '-0.005em',
        }}
      >
        {label}
      </span>
      <button
        type="button"
        // draggable=false + onDragStart blocker: the parent <div> is
        // draggable, so mousedown-with-any-movement inside it can start a
        // drag (parent as source) instead of producing a click. Without
        // these, clicking X with a slightly imperfect press registers as
        // a drag and onClose never fires — manifesting as the "have to
        // click X twice to close" intermittent bug.
        draggable={false}
        onDragStart={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        onMouseDown={(event) => event.stopPropagation()}
        aria-label={t('topTimeline.closeTab')}
        title={t('topTimeline.closeTab')}
        className="app-tab__close"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 16,
          height: 16,
          marginLeft: 2,
          borderRadius: 1,
          border: 'none',
          background: 'transparent',
          color: 'var(--ui-text-muted, hsl(var(--ink-3)))',
          cursor: 'pointer',
          padding: 0,
          flexShrink: 0,
        }}
        onMouseEnter={(event) => {
          event.currentTarget.style.color = 'hsl(var(--ink-1))';
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.color = 'hsl(var(--ink-3))';
        }}
      >
        <BrushIcon name="close" size={12} />
      </button>
      <span className="glass-wave" data-wave-key={tabKey(tab)} aria-hidden />
    </div>
  );
}

interface SplitSlotProps {
  tab: SplitTab;
  isActive: boolean;
  width: number;
  leftLabel: string;
  rightLabel: string;
  leftColor: string | undefined;
  rightColor: string | undefined;
  leftIsDrift: boolean;
  rightIsDrift: boolean;
  onSelectSide: (side: 'left' | 'right') => void;
  onPromoteSide: (side: 'left' | 'right') => void;
  onCloseSide: (side: 'left' | 'right') => void;
}

function SplitTabSlot({
  tab,
  isActive,
  width,
  leftLabel,
  rightLabel,
  leftColor,
  rightColor,
  leftIsDrift,
  rightIsDrift,
  onSelectSide,
  onPromoteSide,
  onCloseSide,
}: SplitSlotProps) {
  return (
    <div
      role="tab"
      aria-selected={isActive}
      data-tab-key={tabKey(tab)}
      className={`app-tab app-tab--split glass glass--rest${isActive ? ' is-active is-on' : ''}`}
      draggable
      style={{
        '--glass-cc': (tab.focused === 'right' ? rightColor : leftColor) || 'var(--glass-clear)',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'stretch',
        width,
        minWidth: TAB_FLOOR_WIDTH * SPLIT_WEIGHT,
        cursor: 'pointer',
        position: 'relative',
        overflow: 'hidden',
        height: '100%',
        userSelect: 'none',
      } as React.CSSProperties}
    >
      <SplitSubLabel
        entityType={tab.left.entityType}
        entityId={tab.left.id}
        label={leftLabel}
        color={leftColor}
        isDrift={leftIsDrift}
        isFocused={isActive && tab.focused === 'left'}
        isPreview={tab.left.isPreview}
        onClick={() => onSelectSide('left')}
        onPromote={() => onPromoteSide('left')}
        onClose={() => onCloseSide('left')}
      />
      <span aria-hidden className="app-tab__split-divider" />
      <SplitSubLabel
        entityType={tab.right.entityType}
        entityId={tab.right.id}
        label={rightLabel}
        color={rightColor}
        isDrift={rightIsDrift}
        isFocused={isActive && tab.focused === 'right'}
        isPreview={tab.right.isPreview}
        onClick={() => onSelectSide('right')}
        onPromote={() => onPromoteSide('right')}
        onClose={() => onCloseSide('right')}
      />
      <span className="glass-wave" data-wave-key={tabKey(tab)} aria-hidden />
    </div>
  );
}

function SplitSubLabel({
  entityType,
  entityId,
  label,
  color,
  isDrift,
  isFocused,
  isPreview,
  onClick,
  onPromote,
  onClose,
}: {
  entityType: TabEntityType;
  entityId: string;
  label: string;
  color: string | undefined;
  isDrift: boolean;
  isFocused: boolean;
  isPreview: boolean;
  onClick: () => void;
  onPromote: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onPromote();
      }}
      onMouseDown={(event) => {
        if (event.button === 1) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
      style={{
        position: 'relative',
        flex: 1,
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        padding: '0 6px 0 8px',
        cursor: 'pointer',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--ui-font-body, 12px)',
        color: isFocused ? 'hsl(var(--ink-1))' : 'hsl(var(--ink-2))',
        // Metric-neutral emphasis (see LeafTabSlot): real bold widens the
        // focused label and truncates it earlier than the unfocused side.
        fontWeight: 400,
        textShadow: isFocused ? '0 0 0.6px currentcolor' : 'none',
        fontStyle: isPreview ? 'italic' : 'normal',
        // Sub-tab keeps transparent bg. The parent SplitTabSlot already
        // paints its tone-selected bg when the split is active, and the
        // focused side is signalled by `color` + the text-shadow — an extra
        // accent tint here just reads as visual clutter.
        background: 'transparent',
        transition: 'none',
      }}
    >
      <span className="app-tab__sand" aria-hidden>
        <KindMark kind={kindMarkOfTarget(entityType, isDrift)} seed={entityId} color={color} />
      </span>
      <KindMark className="app-tab__mark" kind={kindMarkOfTarget(entityType, isDrift)}
        seed={entityId} color={color} hollow={isPreview} />
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0,
          flex: 1,
        }}
      >
        {label}
      </span>
      <button
        type="button"
        // Same "draggable parent eats clicks" guard as the LeafTabSlot X
        // button — the surrounding SplitTabSlot is draggable, and without
        // these blockers a click with any pixel of mouse drift becomes a
        // drag (no click event, no close).
        draggable={false}
        onDragStart={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        onMouseDown={(event) => event.stopPropagation()}
        aria-label={t('topTimeline.closePane')}
        title={t('topTimeline.closePane')}
        className="app-tab__close"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 14,
          height: 14,
          borderRadius: 1,
          border: 'none',
          background: 'transparent',
          color: 'var(--ui-text-muted, hsl(var(--ink-4)))',
          cursor: 'pointer',
          padding: 0,
          flexShrink: 0,
        }}
        onMouseEnter={(event) => {
          event.currentTarget.style.color = 'hsl(var(--ink-1))';
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.color = 'hsl(var(--ink-4))';
        }}
      >
        <BrushIcon name="close" size={10} />
      </button>
    </div>
  );
}

function TabDot({
  tabKeyValue,
  kind,
  seed,
  label,
  color,
  isActive,
  isPreview,
  clusterBreak = false,
  onSelect,
}: {
  tabKeyValue?: string;
  kind: KindMarkKind;
  seed: string;
  label: string;
  color: string | undefined;
  isActive: boolean;
  isPreview: boolean;
  clusterBreak?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role={tabKeyValue ? 'tab' : undefined}
      aria-selected={tabKeyValue ? isActive : undefined}
      aria-label={label}
      title={label}
      data-tab-key={tabKeyValue}
      data-cluster-break={clusterBreak ? 'true' : undefined}
      data-preview={isPreview ? 'true' : undefined}
      className={`app-tab-dot${isActive ? ' is-active' : ''}`}
      onClick={onSelect}
    >
      <KindMark kind={kind} seed={seed} color={color || 'hsl(var(--ink-3))'} hollow={isPreview} />
    </button>
  );
}
