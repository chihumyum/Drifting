/**
 * Element-name selector — reads in-memory bookElements / categories / actions
 * from the data store. Used for dedup in entity-candidate detection (Copilot
 * must not propose names that already exist, nor names the user has rejected
 * before) and to give the prompt a list of legal element categories.
 *
 * Reads from Zustand directly rather than taking a React hook, so it's
 * callable from services and dev-console without a component context.
 */
import { useDataStore } from '../../../../store/data-store';
import type { EntityCandidateMetadata } from '../../../../domain/copilot-suggestion';

/**
 * Every name an element answers to in the given project — canonical name
 * plus all aliases, lowercased and deduplicated. Used for "this proper
 * noun is already a known entity" filtering before we send candidates to
 * the suggestion store. Including aliases is critical: without it,
 * "Lady Mira" gets proposed as a brand-new entity even though Mira is
 * already in the project with that alias.
 */
export function getKnownElementNames(projectId: string): string[] {
  const all = useDataStore.getState().bookElements;
  const seen = new Set<string>();
  for (const el of all) {
    if (el.projectId !== projectId) continue;
    for (const candidate of [el.name, ...el.aliases]) {
      const normalized = candidate.trim().toLowerCase();
      if (normalized) seen.add(normalized);
    }
  }
  return [...seen];
}

/**
 * Element category names available in the project, sorted alphabetically.
 * The entity-candidate prompt uses this to constrain its `suggestedCategoryHint`
 * to categories the user actually has.
 */
export function getAvailableCategoryNames(projectId: string): string[] {
  const categories = useDataStore.getState().bookElementCategories;
  return categories
    .filter((c) => c.projectId === projectId)
    .map((c) => c.name.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Names the user has previously rejected as Copilot suggestions. Drawn from
 * `comment_action` rows with `kind='reject_suggestion'`; we parse each
 * action's payloadJson (which captured the comment's metadataJson at
 * rejection time) and pull out the suggestedName.
 *
 * Lives entirely in-memory: data-store mirrors commentActions for the
 * current project at all times, so this is sub-millisecond.
 */
export function getRejectedSuggestionNames(projectId: string): string[] {
  const actions = useDataStore.getState().commentActions;
  const seen = new Set<string>();
  for (const action of actions) {
    if (action.projectId !== projectId) continue;
    if (action.kind !== 'reject_suggestion') continue;
    try {
      const payload = JSON.parse(action.payloadJson) as Partial<EntityCandidateMetadata>;
      if (
        payload?.kind === 'entity-candidate' &&
        typeof payload.suggestedName === 'string'
      ) {
        const normalized = payload.suggestedName.trim().toLowerCase();
        if (normalized) seen.add(normalized);
      }
    } catch {
      // Malformed payload — skip silently. Logging not worth the noise here.
    }
  }
  return [...seen];
}
