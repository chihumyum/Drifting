/**
 * ElementCandidateContextBuilder — feature-specific augmentation for the
 * element-candidate capability. Consumes the framework's BaseBlockContext
 * (uncovered blocks + prior sections) and adds the project-data the
 * element-candidate prompt needs to decide whether a passage mentions a
 * new element:
 *   - all known element names + aliases (for dedup)
 *   - available element categories (so the model uses real category labels)
 *   - previously rejected names (so we don't keep nagging)
 *
 * Pure data assembly — does not call the model. Returned shape is consumed
 * by `prompts/templates/element-candidate.ts` via callStructured.
 *
 * Renamed from `EntityCandidateContextBuilder` in PR E along with the rest
 * of the capability's vocabulary.
 */
import {
  getAvailableCategoryNames,
  getKnownElementNames,
  getRejectedSuggestionNames,
} from './selectors/elements';
import type { BaseBlockContext, ElementCandidateContext } from './types';

export interface BuildElementCandidateContextInput {
  baseContext: BaseBlockContext;
  projectId: string;
}

export function buildElementCandidateContext(
  input: BuildElementCandidateContextInput,
): ElementCandidateContext | null {
  if (input.baseContext.uncoveredBlocks.length === 0) return null;
  return {
    uncoveredBlocks: input.baseContext.uncoveredBlocks,
    knownElementNames: getKnownElementNames(input.projectId),
    availableCategories: getAvailableCategoryNames(input.projectId),
    rejectedNames: getRejectedSuggestionNames(input.projectId),
  };
}
