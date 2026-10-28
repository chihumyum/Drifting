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

// What only a timeline clip's hover card offers. The shared per-entity
// actions (delete, edit storylines, status flips, ...) come from
// EditorTopBar's getMenuItems via entityHoverActions.
export type BottomTimelineNodeAction =
  // Clears all storyline memberships → chapter becomes 未归属.
  | 'moveToUnaffiliated'
  // Narrative-view only: clears node.narrativeOrder, which moves the
  // node out of the storyline rows and back into the "未放置" popover
  // so the author can re-place it later.
  | 'detachFromNarrative';
