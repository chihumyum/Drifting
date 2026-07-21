/**
 * Patch invalidation — keep a text-anchored element patch's `invalidatedAt` in
 * sync with whether its anchored source prose still exists.
 *
 * A patch created by selecting a span of chapter prose stores that span in
 * `textAnchorJson` (a CommentTextAnchor). When the author later deletes or
 * rewrites that text out of the source chapter, the patch's evidence is gone:
 * it can no longer sanction a divergence, so Shadow / the agent must stop
 * treating it as canon. We mark such patches `invalidatedAt` (and clear it
 * again if the text reappears — e.g. an undo), then let the read-side filters
 * exclude them. The patch row itself is kept (badged in the element editor) so
 * the user can fix or delete it deliberately.
 *
 * Invalidation is recomputed on chapter persist against the freshly-serialized
 * doc (the editor's live content, NOT the possibly-stale contentJson cache —
 * prose truth is Yjs), so it covers the common "author deletes the sentence"
 * path even while editing.
 */
import loglevel from 'loglevel';
import { createElementPatchRepository } from '../sqlite-repo/element-patch-repo';
import { docToPlainText } from '../lib/agent/serialize';
import { updateElementPatchesWithSync } from './synced-entity-commands';
import { eventBus } from '../lib/events';

const log = loglevel.getLogger('patch-validity');
log.setLevel(loglevel.levels.ERROR);

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The anchored verbatim text, or '' when there's no usable text anchor. */
function anchorText(textAnchorJson: string | null): string {
  if (!textAnchorJson) return '';
  try {
    const a = JSON.parse(textAnchorJson) as { text?: unknown };
    return typeof a.text === 'string' ? a.text : '';
  } catch {
    return '';
  }
}

/**
 * Recompute `invalidatedAt` for every text-anchored patch sourced from this
 * chapter, against `contentJson` (the chapter's current serialized doc).
 *
 * A patch is valid iff its anchored text (whitespace-normalized) is still a
 * substring of the chapter's normalized plain text. Whole-chapter (rather than
 * per-block) matching is deliberate: it treats "the phrase is gone from the
 * chapter" as the deletion signal, staying robust to block splits/merges that
 * keep the words intact. Idempotent — only writes (and syncs) on a transition.
 */
export async function recheckChapterPatchValidity(
  projectId: string,
  nodeId: string,
  contentJson: string,
): Promise<void> {
  try {
    const repo = createElementPatchRepository();
    const anchored = (await repo.listBySourceNode(nodeId)).filter(
      (p) => anchorText(p.textAnchorJson).length > 0,
    );
    if (anchored.length === 0) return;

    const haystack = norm(docToPlainText(contentJson));
    const touchedElements = new Set<string>();

    const transitions: Array<{ id: string; updates: { invalidatedAt: string | null } }> = [];
    for (const p of anchored) {
      const present = haystack.includes(norm(anchorText(p.textAnchorJson)));
      const currentlyInvalid = !!p.invalidatedAt;
      if (present === !currentlyInvalid) continue; // no transition

      const nextInvalidatedAt = present ? null : new Date().toISOString();
      transitions.push({ id: p.id, updates: { invalidatedAt: nextInvalidatedAt } });
      touchedElements.add(p.elementId);
    }
    await updateElementPatchesWithSync(projectId, transitions);

    // Nudge any open element editor (PatchesSection has no store subscription)
    // so the invalid badge appears/clears without a manual refresh.
    for (const elementId of touchedElements) {
      eventBus.emit('element:patches-changed', { elementId });
    }
  } catch (error) {
    log.error('Failed to recheck patch validity for node', nodeId, error);
  }
}
