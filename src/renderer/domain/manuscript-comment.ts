// Manuscript comments anchor to structural-entity blocks only; memo /
// material aren't comment-able (they don't host body text the user
// references inline).
import type { CommentTargetKind } from './entity-kinds';
export type { CommentTargetKind };
export type ManuscriptCommentStatus = 'open' | 'resolved' | 'converted';
export type CommentAuthorKind = 'user' | 'ai' | 'copilot' | 'external';
export type CommentSource = 'manual' | 'shadow' | 'copilot' | 'api';
export type CommentPriority = 'low' | 'med' | 'high';
// Comment action log entries. New kinds are additive — `kind` is an
// unconstrained text column at the DB level (see CommentActionTable in
// schema/drizzle.ts), so extending this union does not require migration.
//   - convert_to_memo:  user manually converted a comment to a memo/TODO
//   - accept_suggestion: user accepted a Copilot proposal (status -> 'converted',
//     resultJson carries the created Element id / patch result / etc.)
//   - reject_suggestion: user dismissed a Copilot proposal as incorrect; row
//     stays around as the dedup source ("don't suggest this name again")
export type CommentActionKind =
  | 'convert_to_memo'
  | 'accept_suggestion'
  | 'reject_suggestion';
export type CommentActionStatus = 'pending' | 'applied' | 'failed';

export interface ManuscriptComment {
  id: string;
  projectId: string;
  targetKind: CommentTargetKind;
  targetId: string;
  targetBlockId: string;
  anchorJson: string;
  authorKind: CommentAuthorKind;
  authorId: string | null;
  authorName: string | null;
  bodyJson: string;
  status: ManuscriptCommentStatus;
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
