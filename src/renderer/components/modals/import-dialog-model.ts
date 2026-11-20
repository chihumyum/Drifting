import type { ImportTarget } from '../../services/import';

/**
 * Sentinel value used by the storyline GlassSelect to represent importing
 * chapters without a primary storyline (未归属). Real storyline IDs are
 * non-empty UUIDs, so an empty string never collides with persisted data.
 */
export const UNAFFILIATED_STORYLINE_OPTION = '';

/**
 * User selection state for chapter import storyline:
 * - `undefined`: untouched (auto-defaults to the first storyline if present, otherwise unaffiliated)
 * - `null`: explicitly chosen unaffiliated
 * - `string`: explicitly chosen storyline ID
 */
export type StorylineChoice = string | null | undefined;

export function resolveImportStorylineId(
  choice: StorylineChoice,
  storylines: readonly { id: string }[],
): string | null {
  if (choice === null) return null;
  if (typeof choice === 'string') {
    if (storylines.some((storyline) => storyline.id === choice)) {
      return choice;
    }
    return storylines[0]?.id ?? null;
  }
  return storylines[0]?.id ?? null;
}

export function canCommitImport(input: {
  projectId: string | undefined;
  userId: string | undefined;
  target: ImportTarget;
  categoryId: string | null;
  items: readonly { status: string }[];
}): boolean {
  if (!input.projectId || !input.userId) return false;
  if (input.items.length === 0) return false;
  if (input.items.every((item) => item.status !== 'ready')) return false;
  if (input.target === 'element' && !input.categoryId) return false;
  return true;
}
