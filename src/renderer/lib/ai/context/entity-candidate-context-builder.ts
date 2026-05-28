/**
 * EntityCandidateContextBuilder — feature-specific augmentation for the
 * entity-candidate capability. Consumes the framework's BaseBlockContext
 * (edited blocks + prior sections) and adds the project-data the
 * entity-candidate prompt needs to decide whether a paragraph mentions a
 * new entity:
 *   - all known element names (for dedup)
 *   - available element categories (so the model uses real category labels)
 *   - previously rejected names (so we don't keep nagging)
 *
 * Pure data assembly — does not call the model. Returned shape is consumed
 * by `prompts/templates/entity-candidate.ts` via callStructured.
 */
import {
  getAvailableCategoryNames,
  getKnownElementNames,
  getRejectedSuggestionNames,
} from './selectors/elements';
import type { BaseBlockContext, EntityCandidateContext } from './types';

export interface BuildEntityCandidateContextInput {
  baseContext: BaseBlockContext;
  projectId: string;
}

export function buildEntityCandidateContext(
  input: BuildEntityCandidateContextInput,
): EntityCandidateContext | null {
  if (input.baseContext.uncoveredBlocks.length === 0) return null;
  return {
    uncoveredBlocks: input.baseContext.uncoveredBlocks,
    knownElementNames: getKnownElementNames(input.projectId),
    availableCategories: getAvailableCategoryNames(input.projectId),
    rejectedNames: getRejectedSuggestionNames(input.projectId),
  };
}
