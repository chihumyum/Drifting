/**
 * L4 Context layer types. Provider-agnostic; ContextBuilders translate
 * project data into these shapes, and prompts consume them.
 */

/**
 * A single block (paragraph / heading / list item) extracted from a chapter,
 * with its stable block-id preserved so we can refer back to it precisely.
 */
export interface BlockSnippet {
  blockId: string;
  /** Plain-text content of the block. Marks and formatting are stripped. */
  text: string;
  /**
   * Distance from the focus block in block-position units. Negative = before,
   * 0 = focus, positive = after. Useful for prompt-side weighting.
   */
  offset: number;
}

/**
 * Context for entity-candidate detection at a specific block.
 */
export interface EntityCandidateContext {
  /** The block the user just paused on — Copilot scans this for new entities. */
  focusBlock: BlockSnippet;
  /** Surrounding blocks for narrative context, ordered front-to-back. */
  surroundingBlocks: BlockSnippet[];
  /** All known element names in the current project, normalized. For dedup. */
  knownElementNames: string[];
  /**
   * Element category names available in the project (e.g. "character",
   * "location"). The prompt uses these to hint the kind of each candidate.
   */
  availableCategories: string[];
  /**
   * Names the user has previously rejected as candidates (Copilot won't
   * re-suggest these). Populated from `comment_action` history.
   */
  rejectedNames: string[];
}
