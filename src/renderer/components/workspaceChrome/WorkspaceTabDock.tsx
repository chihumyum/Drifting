import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatAccelerator } from '../../lib/shortcuts';
import { useShortcutsStore } from '../../store/shortcuts-store';
import { useUiStore } from '../../store/ui-store';
import { TopTimeline } from '../topBars/TopTimeline/TopTimeline';

// Leaving the dock collapses it after a short grace period, so a pointer that
// overshoots a chip does not snap the strip back to dots.
const COLLAPSE_DELAY_MS = 260;

/**
 * The dock on the paper's lower edge: the open documents as one strip and,
 * below it, the Bottom Timeline toggle. It replaces the title-bar tab strip.
 * Whole-book views open from beside their entities instead: All Chapters from
 * the chapter panel, the element overview from the element panel, TODO &
 * Materials from the material panel, the story graph from the timeline head
 * and Project Home from the account cell.
 */
export function WorkspaceTabDock() {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [held, setHeld] = useState(false);
  const collapseTimer = useRef<number | null>(null);

  const clearTimer = () => {
    if (collapseTimer.current !== null) window.clearTimeout(collapseTimer.current);
    collapseTimer.current = null;
  };
  useEffect(() => clearTimer, []);
  const onHoldExpanded = useCallback((next: boolean) => setHeld(next), []);

  return (
    <div
      className="workspace-tab-dock"
      onPointerEnter={() => {
        clearTimer();
        setHovered(true);
      }}
      onPointerLeave={() => {
        clearTimer();
        collapseTimer.current = window.setTimeout(() => setHovered(false), COLLAPSE_DELAY_MS);
      }}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <div className="workspace-tab-dock__tabs">
        <TopTimeline expanded={hovered || focused || held} onHoldExpanded={onHoldExpanded} />
      </div>
      <TimelineToggle />
    </div>
  );
}

/** Shows or hides the Bottom Timeline under the paper (⌘J). */
function TimelineToggle() {
  const { t } = useTranslation();
  const hidden = useUiStore((state) => state.bottomTimelineHidden);
  const toggle = useUiStore((state) => state.toggleBottomTimelineHidden);
  const accelerator = useShortcutsStore((state) => state.bindings.toggleBottomTimeline);
  const label = t(hidden ? 'bottomStatusBar.expandTimeline' : 'bottomStatusBar.collapseTimeline');
  return (
    <button
      type="button"
      className="workspace-timeline-toggle"
      aria-pressed={!hidden}
      aria-label={label}
      title={`${label} · ${formatAccelerator(accelerator)}`}
      onClick={toggle}
    >
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
        <rect x="1.5" y="3.5" width="13" height="9" rx="1" />
        <line x1="1.5" y1="7" x2="14.5" y2="7" />
        <line x1="4" y1="10.5" x2="9" y2="10.5" />
      </svg>
    </button>
  );
}
