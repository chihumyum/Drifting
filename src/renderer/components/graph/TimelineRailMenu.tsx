import { useTranslation } from 'react-i18next';
import { ContextMenuSurface } from '../ui/ContextMenuSurface';
import '../../../styles/timeline-pin-menu.css';

// Context menu for the EMPTY area of the narrative time-axis (marker) rail,
// shared by BottomTimeline and StoryGraphView. Right-clicking a blank slot
// offers "在此处新建标记", which drops a marker at that order (the host
// resolves the cursor order before opening this). Right-clicking an existing
// pin opens TimelinePinMenu instead — that pin stops propagation, so this
// menu only ever fires on empty space.
//
// Mirrors TimelinePinMenu: portals to body (fixed positioning escapes
// backdrop-filter containing blocks) and reuses the .tlpin-menu styling +
// outside-click / Esc dismissal.
export interface TimelineRailMenuProps {
  x: number;
  y: number;
  onAddMarker: () => void;
  onClose: () => void;
}

export function TimelineRailMenu({ x, y, onAddMarker, onClose }: TimelineRailMenuProps) {
  const { t } = useTranslation();
  return (
    <ContextMenuSurface x={x} y={y} onClose={onClose} className="tlpin-menu">
      <button
        type="button"
        onClick={() => {
          onClose();
          onAddMarker();
        }}
      >
        {t('bottomTimeline.railMenu.addMarkerHere')}
      </button>
    </ContextMenuSurface>
  );
}
