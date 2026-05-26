/**
 * ElementPatchContextBuilder — assembles inputs for element-patch detection.
 *
 * Symmetric to EntityCandidateContextBuilder but reads richer entity data
 * (id + name + summary) instead of just names, because the element-patch
 * prompt must (a) reference entities by id (no inventing) and (b) avoid
 * proposing patches that just reaffirm what's already in the summary.
 *
 * Pending-patch dedup uses the open copilot suggestion comments — same
 * mechanism the entity-candidate capability uses, with a different key
 * (elementId + short title prefix instead of normalized name).
 */
import type { Editor } from '@tiptap/core';
import { extractBlockContext } from './selectors/block-context';
import { useDataStore } from '../../../store/data-store';
import { decodeCopilotMetadata } from '../../../domain/copilot-suggestion';
import type { BlockSnippet } from './types';

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
  focusBlock: BlockSnippet;
  surroundingBlocks: BlockSnippet[];
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
  editor: Editor;
  projectId: string;
  focusBlockId: string;
  before?: number;
  after?: number;
}

export function buildElementPatchContext(
  input: BuildElementPatchContextInput,
): ElementPatchContext | null {
  const blocks = extractBlockContext(input.editor, input.focusBlockId, {
    before: input.before,
    after: input.after,
  });
  if (!blocks || !blocks.focus.text) return null;

  return {
    focusBlock: blocks.focus,
    surroundingBlocks: blocks.surrounding,
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
