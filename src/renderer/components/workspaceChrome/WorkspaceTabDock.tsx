import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatAccelerator } from '../../lib/shortcuts';
import { useShortcutsStore } from '../../store/shortcuts-store';
import { useUiStore } from '../../store/ui-store';
import { TopTimeline } from '../topBars/TopTimeline/TopTimeline';
import { useTimelineToggleHostedByEditor } from '../editor/editor-corner';
import { BrushIcon } from '../ui/BrushIcon';
import { GhostIconButton } from '../ui/GhostIconButton';

// Leaving the dock collapses it after a short grace period, so a pointer that
// overshoots a pill does not snap the strip back to dots.
const COLLAPSE_DELAY_MS = 260;

/**
 * The dock along the paper's top, on the line of the traffic lights and the
 * sidebar toggles: the open documents as one strip of sand marks that spread
 * into glass pills under the pointer. Its lock keeps the pills out. It
 * replaces the title-bar tab strip. Whole-book views open from beside their
 * entities instead: All Chapters from the chapter panel, the element overview
 * from the element panel, TODO & Materials from the material panel, the story
 * graph from the timeline head and Project Home from the account cell.
 */
export function WorkspaceTabDock() {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const locked = useUiStore((state) => state.tabDockLocked);
  const toggleLocked = useUiStore((state) => state.toggleTabDockLocked);
  // With a sidebar closed its toggle floats over the desk: the row keeps
  // clear of both top corners so it stays centred.
  const clearCorners = useUiStore((state) => !state.sidebars.left.isOpen || !state.sidebars.right.isOpen);
  const collapseTimer = useRef<number | null>(null);

  const clearTimer = () => {
    if (collapseTimer.current !== null) window.clearTimeout(collapseTimer.current);
    collapseTimer.current = null;
  };
  useEffect(() => clearTimer, []);
  const lockLabel = t(locked ? 'topTimeline.dockUnlock' : 'topTimeline.dockLock');

  return (
    <div
      className="workspace-tab-dock"
      data-clear-corners={clearCorners ? 'true' : undefined}
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
        <TopTimeline
          expanded={hovered || focused || locked}
          leading={(
            <button
              type="button"
              className="workspace-tab-dock__lock glass glass--rest glass--round"
              aria-pressed={locked}
              aria-label={lockLabel}
              title={lockLabel}
              onClick={toggleLocked}
            >
              <BrushIcon name={locked ? 'lock-shut' : 'lock-open'} size={14} />
            </button>
          )}
        />
      </div>
    </div>
  );
}

/**
 * Shows or hides the Bottom Timeline under the paper (⌘J): a round glass
 * button in the paper's lower-right corner, to the left of (not part of)
 * the editor's own toolbar. The right-hand editor pane carries it in its
 * corner (EditorTopBar); the stage shows its own only while no visible
 * editor does.
 */
export function StageTimelineToggle() {
  const hostedByEditor = useTimelineToggleHostedByEditor();
  return hostedByEditor ? null : <TimelineToggle stage />;
}

export function TimelineToggle({ stage = false }: { stage?: boolean }) {
  const { t } = useTranslation();
  const hidden = useUiStore((state) => state.bottomTimelineHidden);
  const toggle = useUiStore((state) => state.toggleBottomTimelineHidden);
  const accelerator = useShortcutsStore((state) => state.bindings.toggleBottomTimeline);
  const label = t(hidden ? 'bottomStatusBar.expandTimeline' : 'bottomStatusBar.collapseTimeline');
  return (
    <GhostIconButton
      glass="round"
      className={`workspace-timeline-toggle glass--rest${stage ? ' workspace-timeline-toggle--stage' : ''}`}
      aria-pressed={!hidden}
      aria-label={label}
      title={`${label} · ${formatAccelerator(accelerator)}`}
      onClick={toggle}
      icon={<BrushIcon name="bamboo" />}
    />
  );
}
