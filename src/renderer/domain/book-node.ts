// Author-facing chapter status. `draft`, `finished`, and `discarded` are
// user-selectable from the editor menu; `waiting_review` and `revising` are
// reserved for the AI-review pipeline: marking a draft "finished" will
// eventually route through waiting_review (AI running) → revising (user
// acting on AI feedback) → finished. The pipeline isn't built yet, so today
// the user can also pick the intermediate states directly for testing.
// `discarded` is the soft-delete state — the chapter stays on the timeline
// (no data loss) but is styled as set-aside so the author can tell at a
// glance which chapters they've parked.
export type ChapterWritingStatus =
  | 'draft'
  | 'waiting_review'
  | 'revising'
  | 'finished'
  | 'discarded';

// Drift-node status. Orthogonal to chapter status — drift nodes (free-floating
// inspiration with no main storyline) live on their own axis: `drifting`
// (active, in play) vs `resting` (parked, no longer needed for now). The UI
// surfaces resting drifts in a collapsed footer drawer so they're out of the
// way but not lost.
export type DriftStatus = 'drifting' | 'resting';

// Storage type — the `writing_status` column holds whichever enum is
// appropriate for that row. Disambiguation is by `mainStorylineId`: null
// means drift (DriftStatus values), non-null means chapter (ChapterWritingStatus
// values). New code should narrow via isChapter / isDrift rather than treating
// this as a single flat enum.
export type WritingStatus = ChapterWritingStatus | DriftStatus;

export const CHAPTER_WRITING_STATUSES: readonly ChapterWritingStatus[] = [
  'draft',
  'waiting_review',
  'revising',
  'finished',
  'discarded',
];

export const DRIFT_STATUSES: readonly DriftStatus[] = ['drifting', 'resting'];

export function isDriftStatus(value: WritingStatus): value is DriftStatus {
  return value === 'drifting' || value === 'resting';
}

// Reading-axis stride between two adjacent chapters in bookOrder units.
// Tile width is 4 grid units (shared by BottomTimeline and StoryGraphView);
// the +1 leaves a one-unit breathing gap between the current tail and a
// freshly-created chapter so they don't end up flush against each other.
export const CHAPTER_ORDER_STRIDE = 5;

export interface StoryGraphViewNodePosition {
  x: number;
  y: number;
}

// Fields shared by chapter and drift. The two roles diverge on the axes that
// only chapters participate in — reading order (bookOrder) and storyline
// membership (mainStorylineId) — and on the writingStatus enum domain.
// Everything else (graph position, word count, timestamps) is common.
interface BookNodeBase {
  id: string;
  projectId: string;
  title: string;
  summary: string;
  // Author-defined position on the narrative timeline. null = not yet placed
  // on the narrative axis. Both chapters and drift may sit on the graph view
  // and the narrative axis — only bookOrder is chapter-only.
  narrativeOrder: number | null;
  position: StoryGraphViewNodePosition;
  /**
   * Materialized word count derived from this node's content.
   * Counted as: CJK chars + non-CJK whitespace-separated tokens with
   * at least one alphanumeric (matches MS Word's "字数").
   * 0 for never-edited nodes; backfilled on first save after open.
   */
  wordCount: number;
  createdAt: string;
  updatedAt: string;
}

// Chapter — sits on the reading-order axis (bookOrder always set) and belongs
// to a primary storyline. WritingStatus is the chapter-only enum.
export interface ChapterNode extends BookNodeBase {
  mainStorylineId: string;
  bookOrder: number;
  writingStatus: ChapterWritingStatus;
}

// Drift — free-floating inspiration note. No storyline membership, no place
// on the reading axis, and a separate status enum.
export interface DriftNode extends BookNodeBase {
  mainStorylineId: null;
  bookOrder: null;
  writingStatus: DriftStatus;
}

// Discriminated union. Narrow via `isChapter` / `isDrift` rather than poking
// at `mainStorylineId` inline so the intent is explicit at the use site.
export type BookNode = ChapterNode | DriftNode;

export function isChapter(node: BookNode): node is ChapterNode {
  return node.mainStorylineId !== null;
}

export function isDrift(node: BookNode): node is DriftNode {
  return node.mainStorylineId === null;
}

// Mixed-array sort. Chapters sort by bookOrder ascending; drift rows (which
// have no order) fall to the tail. Most call sites should `.filter(isChapter)`
// first and use a plain subtraction — reach for this helper only when an
// array genuinely contains both kinds and the drift sort position is unused.
export function compareBookOrder(a: BookNode, b: BookNode): number {
  const av = isChapter(a) ? a.bookOrder : Number.POSITIVE_INFINITY;
  const bv = isChapter(b) ? b.bookOrder : Number.POSITIVE_INFINITY;
  return av - bv;
}

// Normalize a loose, record-like node shape (post-merge or wire payload) into
// the discriminated union by branching on mainStorylineId. Used by stores and
// the optimistic-update path where a `{ ...node, ...updates }` merge erases
// the variant information TypeScript needs.
type LooseBookNode = Omit<BookNodeBase, never> & {
  mainStorylineId: string | null;
  bookOrder: number | null;
  writingStatus: WritingStatus;
};
export function normalizeBookNode(node: LooseBookNode): BookNode {
  if (node.mainStorylineId == null) {
    return {
      ...(node as LooseBookNode),
      mainStorylineId: null,
      bookOrder: null,
      writingStatus: (isDriftStatus(node.writingStatus)
        ? node.writingStatus
        : 'drifting') as DriftStatus,
    };
  }
  return {
    ...(node as LooseBookNode),
    mainStorylineId: node.mainStorylineId,
    bookOrder: node.bookOrder ?? 0,
    writingStatus: (isDriftStatus(node.writingStatus)
      ? 'draft'
      : node.writingStatus) as ChapterWritingStatus,
  };
}

export interface BookNodeEdge {
  id: string;
  projectId: string;
  sourceNodeId: string;
  targetNodeId: string;
  label: string;
  // User-defined category — drives StoryGraphView filter chips. null when the
  // author hasn't tagged it; the chips list just whatever distinct values
  // currently exist in the data.
  kind: string | null;
  weight: number;
  isDirected: boolean; // Default true if undefined
  createdAt: string;
  updatedAt: string;
  // Freeform Styling & Geometry
  style?: {
    stroke?: string;
    strokeWidth?: number;
    opacity?: number;
    strokeDasharray?: string;
    filter?: string;
  };
  controlPointOffset?: { x: number; y: number }; // Offset from the midpoint for curvature
  sourceAnchor?: { x: number; y: number }; // Relative to node top-left
  targetAnchor?: { x: number; y: number }; // Relative to node top-left
}
