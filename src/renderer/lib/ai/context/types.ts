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
 * Pointer to a previously-summarized contiguous block range used as
 * recent-context for the model. Built from `block_section` rows whose
 * blockSignature still matches the current prose (stale rows are dropped
 * by the base-context builder before they reach the prompt).
 */
export interface PriorSectionSnippet {
  /** Block ids the summary covers, in document order. Diagnostic only. */
  blockIds: string[];
  /** Summary text — the part that actually goes into the prompt. */
  summary: string;
}

/**
 * Capability-agnostic block context built once per debounce fire and passed
 * to every capability's detect() call. Includes:
 *  - editedBlocks: the dirty-queue blocks the user has touched since the
 *    last successful scan, ordered by document position so the model sees
 *    them as a coherent recent edit narrative
 *  - chapterId: which chapter these blocks live in (capabilities need this
 *    for chapter-scoped lookups — element-patch anchors, prior sections)
 *  - priorSections: hash-validated rolling summaries (filled in PR C; empty
 *    array in PR B — present in the type so capability code can land first)
 *
 * Capabilities still own their domain-specific augmentation (candidate
 * elements, known names, pending dedup keys) — this shape only carries
 * what every block-driven capability needs.
 */
export interface BaseBlockContext {
  chapterId: string;
  editedBlocks: BlockSnippet[];
  priorSections: PriorSectionSnippet[];
  /**
   * Element ids referenced by entityLink marks inside `editedBlocks` (target
   * kind = 'element'). Built once during baseContext assembly so capabilities
   * that operate on existing entities (element-patch) can scope down their
   * candidate list to "actually mentioned in this batch" instead of dumping
   * the whole project entity list into the prompt.
   *
   * Mention detection is strictly mark-based — same source of truth EntityLink
   * uses everywhere else. Aliases linked to the same element id surface here
   * naturally. Plain text mentions without a mark are NOT counted (they're
   * entity-candidate's territory, not element-patch's).
   */
  mentionedElementIds: string[];
}

/**
 * Context for entity-candidate detection across the dirty-block batch.
 * editedBlocks is the same list the framework's BaseBlockContext carries —
 * passed through so the capability has one object to thread into its prompt.
 */
export interface EntityCandidateContext {
  /** Recently-edited blocks (ordered by document position). */
  editedBlocks: BlockSnippet[];
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
