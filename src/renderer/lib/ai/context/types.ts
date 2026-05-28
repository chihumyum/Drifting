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
  /**
   * Blocks the user has touched but that aren't yet covered by a valid
   * rolling summary. These show up in capability prompts as the "recent
   * raw prose" to scan. Renamed from `editedBlocks` in PR D-1 — semantics
   * are now coverage-map-driven, not dirty-queue-driven: an old block
   * that was never summarized counts as uncovered too, not just freshly-
   * edited ones.
   */
  uncoveredBlocks: BlockSnippet[];
  /**
   * Hash-validated rolling summaries for this chapter. Each section's
   * blockIds list reflects only blocks still matching the stored per-block
   * hash — blocks whose text changed since the section was written are
   * excluded here and re-surface in `uncoveredBlocks` instead.
   */
  priorSections: PriorSectionSnippet[];
  /**
   * Element ids referenced by entityLink marks inside `uncoveredBlocks`
   * (target kind = 'element'). Lets capabilities that operate on existing
   * entities (element-patch) scope their candidate list to "actually
   * mentioned in this batch" instead of dumping the whole project entity
   * list. Strictly mark-based; aliases linked to the same element id
   * surface here naturally.
   */
  mentionedElementIds: string[];
}

/**
 * Context for element-candidate detection. uncoveredBlocks is the same list
 * the framework's BaseBlockContext carries — passed through so the capability
 * has one object to thread into its prompt.
 *
 * Renamed from `EntityCandidateContext` in PR E for vocabulary accuracy:
 * this is specifically about BookElement candidates, not the broader
 * Drifting "entity" union.
 */
export interface ElementCandidateContext {
  /** Uncovered (raw, not-yet-summarized) blocks in document order. */
  uncoveredBlocks: BlockSnippet[];
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
