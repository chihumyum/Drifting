import type { EditorCommentRequest } from '../../hooks/useEntityEditor';

// Everything the new patch needs from the chapter selection: where in the
// chapter it lives (chapter + enclosing block), the precise text-fragment
// anchor (so it can be invalidated when that text is deleted), and the block
// snapshot for provenance. Derived from the context-menu EditorCommentRequest.
export interface PatchCreateRequest {
  sourceNodeId: string;
  sourceBlockId: string | null;
  sourceBlockText: string | null;
  selectedText: string;
  textAnchorJson: string | null;
}

/** Build a PatchCreateRequest from the selection-menu's EditorCommentRequest. */
export function patchRequestFromComment(req: EditorCommentRequest): PatchCreateRequest {
  let textAnchorJson: string | null = null;
  let sourceBlockText: string | null = null;
  try {
    const payload = JSON.parse(req.anchorJson) as { textAnchor?: unknown; blockText?: unknown };
    if (payload.textAnchor) textAnchorJson = JSON.stringify(payload.textAnchor);
    if (typeof payload.blockText === 'string') sourceBlockText = payload.blockText;
  } catch {
    /* fall through with nulls — a patch with no text anchor is still valid */
  }
  return {
    sourceNodeId: req.sourceId,
    sourceBlockId: req.targetBlockId,
    sourceBlockText,
    selectedText: req.selectedText,
    textAnchorJson,
  };
}
