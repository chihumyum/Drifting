/**
 * ElementPatchContextBuilder — feature-specific augmentation for the
 * element-patch capability. Consumes the framework's BaseBlockContext
 * (edited blocks + prior sections) and adds:
 *   - all non-deleted elements in the project (id + name + aliases + summary)
 *   - pending-patch dedup keys from open copilot suggestion comments
 *
 * Reads richer entity data than entity-candidate (id + name + aliases +
 * summary instead of just names) because the element-patch prompt must
 * (a) reference entities by id (no inventing) and (b) avoid proposing
 * patches that just reaffirm what's already in the summary.
 */
import { useDataStore } from '../../../store/data-store';
import { decodeCopilotMetadata } from '../../../domain/copilot-suggestion';
import type { BaseBlockContext, BlockSnippet } from './types';

export interface ElementProfile {
  id: string;
  name: string;
  /**
   * Alternate names — passed to the model so it can resolve coreference
   * ("Lady Mira" → Mira) without inventing new entities. Always returned
   * (empty array if the element has none).
   */
  aliases: string[];
  /** Trimmed summary; empty string when the entity has none. */
  summary: string;
}

export interface ElementPatchContext {
  /** Recently-edited blocks (ordered by document position). */
  editedBlocks: BlockSnippet[];
  /** All non-deleted elements in the project. */
  candidateElements: ElementProfile[];
  /**
   * Identifiers of currently-open copilot patch suggestions, in the form
   * `${elementId}::${titlePrefix}`. Used as a strong-dedup signal so we
   * don't re-propose a patch the user hasn't decided on yet.
   */
  pendingPatchKeys: string[];
}

export interface BuildElementPatchContextInput {
  baseContext: BaseBlockContext;
  projectId: string;
}

export function buildElementPatchContext(
  input: BuildElementPatchContextInput,
): ElementPatchContext | null {
  if (input.baseContext.editedBlocks.length === 0) return null;
  return {
    editedBlocks: input.baseContext.editedBlocks,
    candidateElements: gatherProjectElements(input.projectId),
    pendingPatchKeys: gatherPendingPatchKeys(input.projectId),
  };
}

function gatherProjectElements(projectId: string): ElementProfile[] {
  const all = useDataStore.getState().bookElements;
  const out: ElementProfile[] = [];
  for (const el of all) {
    if (el.projectId !== projectId) continue;
    out.push({
      id: el.id,
      name: el.name.trim(),
      aliases: el.aliases.map((a) => a.trim()).filter((a) => a.length > 0),
      // Trim and collapse whitespace; some summaries carry editorial newlines.
      summary: el.summary.replace(/\s+/g, ' ').trim(),
    });
  }
  return out;
}

function gatherPendingPatchKeys(projectId: string): string[] {
  const keys = new Set<string>();
  for (const comment of useDataStore.getState().manuscriptComments) {
    if (comment.projectId !== projectId) continue;
    if (comment.source !== 'copilot') continue;
    if (comment.status !== 'open') continue;
    const meta = decodeCopilotMetadata(comment.metadataJson);
    if (meta?.kind === 'element-patch') {
      keys.add(pendingKey(meta.elementId, meta.patchTitle));
    }
  }
  return [...keys];
}

/** Stable dedup key for a pending patch — element id + short title prefix. */
export function pendingKey(elementId: string, title: string): string {
  const trimmed = title.trim().slice(0, 60);
  return `${elementId}::${trimmed}`;
}
