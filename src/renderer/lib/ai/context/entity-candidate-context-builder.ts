/**
 * EntityCandidateContextBuilder — assembles everything the entity-candidate
 * prompt needs to decide whether a paragraph mentions a new entity:
 *   - the focus block + surrounding narrative (from the active editor)
 *   - all known element names (for dedup)
 *   - available element categories (so the model uses real category labels)
 *   - previously rejected names (so we don't keep nagging)
 *
 * Pure data assembly — does not call the model. Returned shape is consumed
 * by `prompts/templates/entity-candidate.ts` via callStructured.
 */
import type { Editor } from '@tiptap/core';
import { extractBlockContext } from './selectors/block-context';
import {
  getAvailableCategoryNames,
  getKnownElementNames,
  getRejectedSuggestionNames,
} from './selectors/elements';
import type { EntityCandidateContext } from './types';

export interface BuildEntityCandidateContextInput {
  editor: Editor;
  projectId: string;
  focusBlockId: string;
  /** Override default surrounding window (2 before / 2 after). */
  before?: number;
  after?: number;
}

export function buildEntityCandidateContext(
  input: BuildEntityCandidateContextInput,
): EntityCandidateContext | null {
  const blocks = extractBlockContext(input.editor, input.focusBlockId, {
    before: input.before,
    after: input.after,
  });
  if (!blocks) return null;

  // Skip empty / whitespace-only focus blocks — sending these would burn
  // tokens for zero signal. The caller (trigger pipeline) should already
  // filter these out, but defending here keeps the prompt invariant clean.
  if (!blocks.focus.text) return null;

  return {
    focusBlock: blocks.focus,
    surroundingBlocks: blocks.surrounding,
    knownElementNames: getKnownElementNames(input.projectId),
    availableCategories: getAvailableCategoryNames(input.projectId),
    rejectedNames: getRejectedSuggestionNames(input.projectId),
  };
}
