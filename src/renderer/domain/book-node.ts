// Author-facing chapter status. `draft`, `finished`, and `discarded` are
// user-selectable (MANUAL_CHAPTER_WRITING_STATUSES, offered by the editor
// top-bar menu and the chapter panel's cell context menu); `waiting_review`
// and `revising` are reserved for the AI-review pipeline: marking a draft
// "finished" routes through waiting_review (AI running) → revising (user
// acting on AI feedback) → finished.
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
// appropriate for that row. Disambiguation is by the explicit `kind` field.
// New code should narrow via isChapter / isDrift rather than treating this
// as a single flat enum.
export type WritingStatus = ChapterWritingStatus | DriftStatus;

// Chapter / drift discriminator. Materialized on book_node.kind. Replaces the
// historical "mainStorylineId nullability" implicit discriminator: a chapter
// without a primary storyline link is still a chapter (kind='chapter'), not
// auto-degraded to drift.
export type BookNodeKind = 'chapter' | 'drift';

export const CHAPTER_WRITING_STATUSES: readonly ChapterWritingStatus[] = [
  'draft',
  'waiting_review',
  'revising',
  'finished',
  'discarded',
];

// The subset the author can pick by hand (editor top-bar menu AND the chapter
// panel cell's context menu — keep the two surfaces identical). waiting_review
// / revising stay system-driven by the AI-review pipeline.
export const MANUAL_CHAPTER_WRITING_STATUSES: readonly ChapterWritingStatus[] = [
  'draft',
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
  // Containing drift group (left-panel folder). null = root level / ungrouped.
  // Drift-only: chapters are always null — grouping is a drift affordance.
  // See domain/drift-group.ts and useDriftGroup.
  driftGroupId: string | null;
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

// Chapter — sits on the reading-order axis. `bookOrder` is always set
// (chapters keep their position even when "未归属"). The primary storyline
// (if any) is derived from node_storyline_link.is_primary; readers should
// consult `useDataStore().primaryStorylineByNode[nodeId]`.
//
// WritingStatus is the chapter-only enum.
export interface ChapterNode extends BookNodeBase {
  kind: 'chapter';
  bookOrder: number;
  writingStatus: ChapterWritingStatus;
}

// Drift — free-floating inspiration note. No storyline membership, no place
// on the reading axis, and a separate status enum.
export interface DriftNode extends BookNodeBase {
  kind: 'drift';
  bookOrder: null;
  writingStatus: DriftStatus;
}

// Discriminated union. Narrow via `isChapter` / `isDrift` (which inspect the
// explicit `kind` field) rather than poking at any other property — the
// discriminator is exactly `kind`, nothing else.
export type BookNode = ChapterNode | DriftNode;

export function isChapter(node: BookNode): node is ChapterNode {
  return node.kind === 'chapter';
}

export function isDrift(node: BookNode): node is DriftNode {
  return node.kind === 'drift';
}

// Coarse writing-status bucket shared by the dashboard and the all-chapters
// stats. Collapses the writingStatus enum (+ an empty-draft heuristic) into
// four progress buckets. Drift nodes carry their own status domain and are
// filtered out before this is called.
//   finished                                   → done
//   waiting_review / revising / draft+content  → draft
//   draft with no content yet                  → todo
//   discarded                                  → set-aside, not progress
export type DerivedStatus = 'done' | 'draft' | 'todo' | 'discarded';
export function deriveStatus(node: {
  writingStatus: WritingStatus;
  wordCount: number;
}): DerivedStatus {
  const s = node.writingStatus;
  if (s === 'finished') return 'done';
  if (s === 'discarded') return 'discarded';
  if (s === 'draft' && (node.wordCount || 0) === 0) return 'todo';
  if (s === 'draft' || s === 'waiting_review' || s === 'revising') return 'draft';
  return 'todo';
}

/**
 * A project-unique title for a node (chapters AND drifts share one namespace),
 * so the writing agent can address a node by title instead of its long uuid.
 * Case-insensitive; appends " 2", " 3", … until free. `excludeId` is the node
 * being renamed (so re-saving its own title is a no-op). Empty → "Untitled".
 */
export function makeUniqueNodeTitle(
  baseTitle: string,
  existingNodes: BookNode[],
  projectId: string,
  excludeId?: string,
): string {
  const base = (baseTitle ?? '').trim() || 'Untitled';
  const taken = new Set(
    existingNodes
      .filter((n) => n.projectId === projectId && n.id !== excludeId)
      .map((n) => n.title.trim().toLowerCase()),
  );
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
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
// the discriminated union. The explicit `kind` field is preserved as-is —
// chapters are never auto-coerced to drift, even when bookOrder happens to be
// null. Used by stores and the optimistic-update path where a
// `{ ...node, ...updates }` merge erases the variant information TS needs.
type LooseBookNode = Omit<BookNodeBase, never> & {
  kind: BookNodeKind;
  bookOrder: number | null;
  writingStatus: WritingStatus;
};
export function normalizeBookNode(node: LooseBookNode): BookNode {
  // Destructure off the discriminator-axis fields so the spread doesn't carry
  // their `LooseBookNode` types into the result.
  const { kind, bookOrder: _bookOrder, writingStatus: _writingStatus, ...rest } = node;
  void _bookOrder;
  void _writingStatus;
  if (kind === 'drift') {
    return {
      ...rest,
      kind: 'drift',
      bookOrder: null,
      writingStatus: (isDriftStatus(node.writingStatus)
        ? node.writingStatus
        : 'drifting') as DriftStatus,
    };
  }
  return {
    ...rest,
    kind: 'chapter',
    bookOrder: node.bookOrder ?? 0,
    writingStatus: (isDriftStatus(node.writingStatus)
      ? 'draft'
      : node.writingStatus) as ChapterWritingStatus,
  };
}

// Story-graph edges are no longer a standalone entity. Visual relations
// between nodes (and any other entity kinds) are stored as rows in
// `entity_relation` — fromKind/toKind carry the endpoint types, `kind` holds
// the user's free-form relation category, and the renderer derives all
// geometry from the current node positions. See `EntityRelationLink` in
// `store/data-store.ts` for the runtime shape.
