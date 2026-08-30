import type { ComponentProps } from 'react';
import { StickyNoteRail } from '../../../components/editor/StickyNoteRail';

type DesktopStickyNoteRailProps = ComponentProps<typeof StickyNoteRail>;

/** Desktop block-anchored geometry around shared comment data and card behavior. */
export function DesktopStickyNoteRail(props: DesktopStickyNoteRailProps) {
  return <StickyNoteRail {...props} />;
}
