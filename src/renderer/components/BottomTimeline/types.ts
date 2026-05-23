import type { BookNode } from '../../domain/book-node';
import type { Storyline } from '../../domain/storyline';

// BottomTimeline filters drift out (only nodes with a primary storyline land
// in the rows), so the timeline-side type is always a chapter plus its
// resolved storyline memberships. Drift nodes don't reach here.
//
// We intersect with BookNode rather than `extends BookNode` because BookNode
// is a discriminated union; `extends` doesn't accept unions, but the
// intersection collapses cleanly to ChapterNode (the variant that satisfies
// the upstream filter).
export type TimelineNode = BookNode & { storylines: Storyline[] };

export type BottomTimelineContextMenuType = 'storyline' | 'node';

export interface BottomTimelineContextMenuState {
  x: number;
  y: number;
  type: BottomTimelineContextMenuType;
  storylineId?: string;
  nodeId?: string;
  position?: number;
  nodeTitle?: string;
  nodeSummary?: string | null;
  nodeStorylines?: Storyline[];
}

// BottomTimeline-local action set. The shared per-entity menu options
// (delete, edit storylines, status flips, ...) come from EditorTopBar's
// getMenuItems via EntityCellContextMenu — only the actions unique to the
// timeline live here.
export type BottomTimelineContextMenuAction =
  // Create a chapter at the cursor's bookOrder slot on the right-clicked
  // storyline row. Only present when the click landed on empty track.
  | 'createChapterHere'
  // Clears all storyline memberships → chapter becomes 未归属.
  | 'moveToUnaffiliated'
  // Narrative-view only: clears node.narrativeOrder, which moves the
  // node out of the storyline rows and back into the "未放置" popover
  // so the author can re-place it later.
  | 'detachFromNarrative';
