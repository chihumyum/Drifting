import type { EntityKind } from '../lib/extensions/entity-link';

export type CommentTargetKind = Extract<
  EntityKind,
  'node' | 'element' | 'storyline' | 'category' | 'patch'
>;
export type ManuscriptCommentStatus = 'open' | 'resolved' | 'converted';
export type CommentAuthorKind = 'user' | 'ai' | 'copilot' | 'external';
export type CommentSource = 'manual' | 'shadow' | 'copilot' | 'api';
export type CommentPriority = 'low' | 'med' | 'high';
export type CommentActionKind = 'convert_to_memo';
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
