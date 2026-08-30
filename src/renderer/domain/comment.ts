// Comments are the single home for {block-anchored notes, chapter-anchored
// TODOs, floating TODOs, AI suggestions}. `kind` distinguishes 'note' (the
// classic Word-style marginal annotation), 'todo' (surfaces in the
// right-sidebar TODO list and is what agent pipelines consume), and 'exception'
// (a manual, block-anchored "this is intentional" note for collaborators and
// General Agent context).
// target_* are nullable so a comment can sit at block / chapter / nowhere — see
// drizzle.ts for the anchor matrix.
import type { CommentTargetKind } from './entity-kinds';
export type { CommentTargetKind };

// 'exception' is kind-only (no migration — `kind` is unconstrained text). It is
// meaningful on manual comments (source='manual'). See agent-memory.ts for the un-anchored
// counterpart (standing directives live in memory, not comments).
export type CommentKind = 'note' | 'todo' | 'exception';
export type CommentStatus = 'open' | 'resolved' | 'converted';
export type CommentAuthorKind = 'user' | 'ai' | 'copilot' | 'external';
export type CommentSource = 'manual' | 'copilot' | 'api';
export type CommentPriority = 'low' | 'med' | 'high';
// Comment action log entries. New kinds are additive — `kind` is an
// unconstrained text column at the DB level (see CommentActionTable in
// schema/drizzle.ts), so extending this union does not require migration.
//   - accept_suggestion: user accepted a Copilot proposal (status -> 'converted',
//     resultJson carries the created Element id / patch result / etc.)
//   - reject_suggestion: user dismissed a Copilot proposal as incorrect; row
//     stays around as the dedup source ("don't suggest this name again")
//
// Note: legacy 'convert_to_memo' rows may still exist in older databases (the
// pre-consolidation memo conversion path). Readers should treat unknown kinds
// as inert — there's no live convert_to_memo handler anymore.
export type CommentActionKind = 'accept_suggestion' | 'reject_suggestion';
export type CommentActionStatus = 'pending' | 'applied' | 'failed';

export interface Comment {
  id: string;
  projectId: string;
  kind: CommentKind;
  /** null when the comment is project-level / floating. */
  targetKind: CommentTargetKind | null;
  targetId: string | null;
  /** null when the comment is chapter-level (no specific block) or floating. */
  targetBlockId: string | null;
  anchorJson: string;
  authorKind: CommentAuthorKind;
  authorId: string | null;
  authorName: string | null;
  bodyJson: string;
  status: CommentStatus;
  priority: CommentPriority | null;
  source: CommentSource;
  metadataJson: string | null;
  /** JSON array of block ids this comment anchors to (a consecutive range).
   *  Parsed at use; targetBlockId is the primary/first. Default '[]'. */
  targetBlockIdsJson: string;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommentAction {
  id: string;
  projectId: string;
  commentId: string;
  kind: CommentActionKind;
  label: string | null;
  payloadJson: string;
  status: CommentActionStatus;
  resultJson: string | null;
  createdByKind: CommentAuthorKind;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  appliedAt: string | null;
}

export interface CommentAnchorPayload {
  selectedText?: string;
  selectionFrom?: number;
  selectionTo?: number;
  createdAt?: string;
  // v2 (additive, optional): a snapshot of the entire source block's plain
  // text at comment-creation time, plus the selection offsets within that
  // snapshot. Lets the card render the selected fragment in context — and
  // survives the block being edited or deleted entirely. Older anchors
  // lack these fields; renderers fall back to selectedText only.
  blockText?: string;
  blockSelectionFrom?: number;
  blockSelectionTo?: number;
  // v3 (additive, optional): the ORIGINAL plain text of every block the
  // selection spanned, captured at creation. Powers the card's "view original
  // text" affordance for multi-block comments and survives later edits /
  // deletions of any block in the range. Single-block comments still get one
  // entry. Older anchors lack this; renderers fall back to blockText.
  blockSnapshots?: { blockId: string | null; blockText: string }[];
  // v4 (additive, optional): a PRECISE, possibly multi-block text range —
  // start/end block id + char offset within each + the exact selected text.
  // Present when the comment targets a sub-block / cross-block text span (the
  // "text" and "blocks+text" anchor modes); absent for pure whole-block anchors
  // (which highlight the whole block instead). Drives the fine-grained hover
  // highlight (a DOM Range) and text-level "original changed?" detection.
  textAnchor?: CommentTextAnchor;
}

export interface CommentTextAnchor {
  startBlockId: string;
  /** Char offset of the selection start within startBlockId's plain text. */
  startOffset: number;
  endBlockId: string;
  /** Char offset of the selection end within endBlockId's plain text. */
  endOffset: number;
  /** The exact selected text — the robust key for re-locating / change-detection. */
  text: string;
}

export interface CommentBlockSnapshot {
  blockText: string;
  /** Offset within blockText where the selection starts, or -1 if unknown. */
  from: number;
  /** Offset within blockText where the selection ends, or -1 if unknown. */
  to: number;
}

// A comment can be tied to an entity two ways: its own target_* columns
// (single, can reach block granularity), or a curated entity_relation edge
// (`comment:<id> → kind:id`, many, entity-level — the right-sidebar TODO path).
// Any surface answering "which comments are about this entity" must consider
// BOTH, or the two paths disagree (e.g. the editor's comment count showing 0
// while the ReviewPanel shows comments and TODOs linked to the same entity).

export interface EntityRelationRef {
  projectId: string;
  fromKind: string;
  fromId: string;
  toKind: string;
  toId: string;
}

/**
 * Ids of comments carrying a relation edge that points AT (targetKind,
 * targetId). Empty when the target is unset. See note above.
 */
export function commentIdsRelatedToEntity(
  relations: EntityRelationRef[],
  projectId: string,
  targetKind: CommentTargetKind | null,
  targetId: string | null,
): Set<string> {
  const ids = new Set<string>();
  if (!targetKind || !targetId) return ids;
  for (const r of relations) {
    if (
      r.projectId === projectId &&
      r.fromKind === 'comment' &&
      r.toKind === targetKind &&
      r.toId === targetId
    ) {
      ids.add(r.fromId);
    }
  }
  return ids;
}

/**
 * Whether a comment is "about" (targetKind, targetId) via EITHER its target_*
 * columns or a relation edge (relatedIds from {@link commentIdsRelatedToEntity}).
 * Block anchoring is orthogonal — callers wanting only entity-level (loose)
 * comments additionally check `targetBlockId === null`.
 */
export function commentBelongsToEntity(
  comment: Comment,
  targetKind: CommentTargetKind,
  targetId: string,
  relatedIds: Set<string>,
): boolean {
  return (
    (comment.targetKind === targetKind && comment.targetId === targetId) ||
    relatedIds.has(comment.id)
  );
}

export function createPlainCommentDoc(text: string): string {
  const trimmed = text.trim();
  const paragraphs = trimmed.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  return JSON.stringify({
    type: 'doc',
    content:
      paragraphs.length > 0
        ? paragraphs.map((part) => ({
            type: 'paragraph',
            content: [{ type: 'text', text: part.replace(/\n+/g, ' ') }],
          }))
        : [{ type: 'paragraph', content: [] }],
  });
}

export function extractTextFromCommentBody(bodyJson: string | null | undefined): string {
  if (!bodyJson) return '';
  try {
    const parsed = JSON.parse(bodyJson);
    const chunks: string[] = [];
    const visit = (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      if (typeof record.text === 'string') chunks.push(record.text);
      const content = record.content;
      if (Array.isArray(content)) {
        content.forEach(visit);
      }
      const type = record.type;
      if (type === 'paragraph' || type === 'heading' || type === 'blockquote') {
        chunks.push('\n');
      }
    };
    visit(parsed);
    return chunks.join('').replace(/\n{3,}/g, '\n\n').trim();
  } catch {
    return '';
  }
}

export function getSelectedTextFromAnchor(anchorJson: string | null | undefined): string {
  if (!anchorJson) return '';
  try {
    const parsed = JSON.parse(anchorJson) as CommentAnchorPayload;
    return typeof parsed.selectedText === 'string' ? parsed.selectedText : '';
  } catch {
    return '';
  }
}

export function getBlockSnapshotFromAnchor(
  anchorJson: string | null | undefined,
): CommentBlockSnapshot | null {
  if (!anchorJson) return null;
  try {
    const parsed = JSON.parse(anchorJson) as CommentAnchorPayload;
    if (typeof parsed.blockText !== 'string') return null;
    const from =
      typeof parsed.blockSelectionFrom === 'number' ? parsed.blockSelectionFrom : -1;
    const to = typeof parsed.blockSelectionTo === 'number' ? parsed.blockSelectionTo : -1;
    return { blockText: parsed.blockText, from, to };
  } catch {
    return null;
  }
}

/**
 * Original plain text of every block this comment spanned, captured at creation
 * (anchor v3 `blockSnapshots`). Falls back to the single-block v2 snapshot
 * (`blockText`) so older comments still yield one entry. Empty when nothing was
 * captured. Used by the card's "view original text" button — it survives the
 * blocks being later edited or deleted.
 */
export function getBlockSnapshotsFromAnchor(
  anchorJson: string | null | undefined,
): { blockId: string | null; blockText: string }[] {
  if (!anchorJson) return [];
  try {
    const parsed = JSON.parse(anchorJson) as CommentAnchorPayload;
    if (Array.isArray(parsed.blockSnapshots)) {
      const snaps = parsed.blockSnapshots.filter(
        (s): s is { blockId: string | null; blockText: string } =>
          !!s && typeof s.blockText === 'string',
      );
      if (snaps.length > 0) return snaps;
    }
    if (typeof parsed.blockText === 'string') {
      return [{ blockId: null, blockText: parsed.blockText }];
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * The block ids a comment anchors to — its consecutive range from
 * `targetBlockIdsJson` (a first-class field written by BOTH manual multi-block
 * selection and automated writers), falling back to the single `targetBlockId`. Shared by
 * the rail's hover highlight and the scroll-map ticks so a multi-block comment
 * is handled identically everywhere.
 */
export function commentBlockIds(comment: Comment): string[] {
  try {
    const arr = JSON.parse(comment.targetBlockIdsJson) as unknown;
    if (Array.isArray(arr)) {
      const ids = arr.filter((b): b is string => typeof b === 'string' && b.length > 0);
      if (ids.length > 0) return ids;
    }
  } catch {
    /* malformed — fall back to the single primary block below */
  }
  return comment.targetBlockId ? [comment.targetBlockId] : [];
}

/** The precise text range a comment anchors to, or null for a whole-block anchor. */
export function getTextAnchorFromAnchor(
  anchorJson: string | null | undefined,
): CommentTextAnchor | null {
  if (!anchorJson) return null;
  try {
    const parsed = JSON.parse(anchorJson) as CommentAnchorPayload;
    const t = parsed.textAnchor;
    if (
      t &&
      typeof t.startBlockId === 'string' &&
      typeof t.endBlockId === 'string' &&
      typeof t.text === 'string' &&
      typeof t.startOffset === 'number' &&
      typeof t.endOffset === 'number'
    ) {
      return t;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** First verbatim {from,to} of `needle` in `haystack`, or null. */
export function locateTextInBlock(
  haystack: string,
  needle: string,
): { from: number; to: number } | null {
  const n = needle.trim();
  if (!n) return null;
  const i = haystack.indexOf(n);
  return i < 0 ? null : { from: i, to: i + n.length };
}

/** Visual family used across card / rail-icon / scroll-tick / in-prose highlight.
 *  A TODO is yellow regardless of where it came from; otherwise by source. */
export type CommentColorKey = 'todo' | 'manual' | 'copilot';
export function commentColorKey(comment: Comment): CommentColorKey {
  if (comment.kind === 'todo') return 'todo';
  if (comment.source === 'copilot') return 'copilot';
  return 'manual';
}
