/**
 * Copilot suggestion metadata — the structured payload we stash in
 * `manuscript_comment.metadataJson` whenever Copilot writes a suggestion
 * comment (`source: 'copilot'`, `authorKind: 'copilot'`).
 *
 * Why on a comment row: the manuscript_comment table is the existing
 * anchored-annotation surface. By reusing it, Copilot suggestions get
 * persistence, sync, optimistic update, and a visible margin rail for free.
 * Source-aware rendering (Tab/Esc buttons in place of resolve/convert) lives
 * in the shared Review card.
 *
 * Tagged union by `kind` so Phase 2's Element Patch proposals can share the
 * same comment surface without a separate table.
 */

/**
 * Element-candidate proposal — Copilot detected a probable new character /
 * location / item / etc. that isn't yet in the project's BookElement list.
 *
 * Renamed from `EntityCandidateMetadata` (kind: 'entity-candidate') — the
 * old name conflated Drifting's domain "entity" (the union of node /
 * storyline / element / memo / material) with the specific case this
 * capability handles, which is BookElement. Legacy persisted comments
 * still carry the old kind value; `decodeCopilotMetadata` normalises them
 * on read so the rest of the codebase only sees the new kind.
 */
export interface ElementCandidateMetadata {
  kind: 'element-candidate';

  /** The proper noun the model proposes adding. */
  suggestedName: string;

  /**
   * Hint for which element category to use on accept. Final category may be
   * decided by the accept handler if this hint doesn't match the project's
   * actual category set.
   */
  suggestedCategoryHint: string;

  /**
   * 1-2 sentence sketch the model wrote based ONLY on what recentText
   * revealed about the new element — role, identifying traits, relationship.
   * Empty string when the text just mentioned the name in passing without
   * giving anything to summarize. Persisted to `element.summary` on accept.
   */
  initialDescription?: string;

  /** Excerpt from the paragraph that triggered the suggestion. */
  evidenceText: string;
  /** Character offset within the block, if the model returned one. */
  evidenceFrom?: number;
  evidenceTo?: number;

  /** Model self-reported confidence in [0, 1]. */
  confidence: number;

  /** Provenance — lets us debug + filter by prompt version when tuning. */
  promptId: string;
  promptVersion: number;
  model: string;
}

/**
 * Element-patch proposal — Copilot read the paragraph and thinks it
 * reveals a state change about an existing entity (motivation shift,
 * knowledge update, relationship change, etc.) that the author should
 * persist as a chapter-anchored patch row on that entity.
 */
export interface ElementPatchMetadata {
  kind: 'element-patch';

  /** Existing BookElement to patch. */
  elementId: string;
  /** Denormalized for rendering — saves a lookup in ReviewItemCard. */
  elementName: string;

  /** One-line summary of the change ("Bjorn now trusts Erik"). */
  patchTitle: string;
  /** Longer narrative the model wants to attach as patch body. */
  patchBody: string;

  /** Short verbatim excerpt from the focus block that triggered the patch. */
  evidenceText: string;

  /**
   * Full plain-text of the block the evidence was anchored to. Captured at
   * detect time so the accept path can persist it as an audit snapshot —
   * surfaced in the patch UI when the original block has since been
   * deleted from the chapter. Optional because legacy suggestions
   * predating this field won't have it.
   */
  sourceBlockText?: string;

  /** Model self-reported confidence [0, 1]. */
  confidence: number;

  promptId: string;
  promptVersion: number;
  model: string;
}

export type CopilotSuggestionMetadata = ElementCandidateMetadata | ElementPatchMetadata;

export function encodeCopilotMetadata(meta: CopilotSuggestionMetadata): string {
  return JSON.stringify(meta);
}

export function decodeCopilotMetadata(
  json: string | null | undefined,
): CopilotSuggestionMetadata | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { kind?: unknown } & Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.kind !== 'string') {
      return null;
    }
    // Backward-compat: pre-rename metadata persisted kind === 'entity-candidate'.
    // Normalise on read so the rest of the codebase only handles the new
    // discriminator. Storage is left untouched; if the user accepts/rejects
    // the comment downstream code rewrites the metadata with the new kind.
    if (parsed.kind === 'entity-candidate') {
      parsed.kind = 'element-candidate';
    }
    return parsed as unknown as CopilotSuggestionMetadata;
  } catch {
    return null;
  }
}

/**
 * Result payload stored on `comment_action.resultJson` when a copilot
 * suggestion is accepted. Discriminated to match the source metadata kind.
 */
export interface AcceptElementCandidateResult {
  kind: 'element-candidate';
  /** ID of the BookElement created by the accept handler. */
  createdElementId: string;
}

export interface AcceptElementPatchResult {
  kind: 'element-patch';
  /** Created row id from element_patch table. */
  createdPatchId: string;
  /** Element the patch attached to (denormalized for convenience). */
  elementId: string;
}

export type AcceptCopilotResult = AcceptElementCandidateResult | AcceptElementPatchResult;
