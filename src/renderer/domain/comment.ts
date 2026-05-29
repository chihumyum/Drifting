// Comments are the single home for {block-anchored notes, chapter-anchored
// TODOs, floating TODOs, AI suggestions}. `kind` distinguishes 'note' (the
// classic Word-style marginal annotation) from 'todo' (surfaces in the
// right-sidebar TODO list and is what agent pipelines consume). target_* are
// nullable so a comment can sit at block / chapter / nowhere — see drizzle.ts
// for the anchor matrix.
import type { CommentTargetKind } from './entity-kinds';
export type { CommentTargetKind };

export type CommentKind = 'note' | 'todo';
export type CommentStatus = 'open' | 'resolved' | 'converted';
export type CommentAuthorKind = 'user' | 'ai' | 'copilot' | 'external';
export type CommentSource = 'manual' | 'shadow' | 'copilot' | 'api';
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
}

export interface CommentBlockSnapshot {
  blockText: string;
  /** Offset within blockText where the selection starts, or -1 if unknown. */
  from: number;
  /** Offset within blockText where the selection ends, or -1 if unknown. */
  to: number;
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
