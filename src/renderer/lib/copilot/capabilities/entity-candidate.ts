/**
 * Entity-candidate capability — Copilot's first feature.
 *
 * Detects proper nouns in a paragraph that look like new characters /
 * locations / items not yet in the project's element list. Produces
 * `EntityCandidateMetadata` suggestion payloads that the runner persists
 * as copilot-source manuscript comments.
 *
 * Everything entity-candidate-specific lives in this file:
 *   - the prompt (imported from lib/ai/prompts/templates)
 *   - the context-builder call
 *   - dedup post-filter
 *   - render hint for CommentRail
 *   - accept handler (Phase 1 PR 5 — currently stubbed)
 *
 * The framework (`lib/copilot/capability.ts` + runner + CommentRail) never
 * imports anything from this file — it only sees the CopilotCapability
 * interface. Adding a sibling capability (element-patch, inline-chat, …)
 * is a parallel file with the same shape.
 */
import type { Editor } from '@tiptap/core';
import loglevel from 'loglevel';
import { callStructured } from '../../ai/call-structured';

const log = loglevel.getLogger('copilot:entity-candidate');
import { buildEntityCandidateContext } from '../../ai/context/entity-candidate-context-builder';
import { entityCandidatePrompt } from '../../ai/prompts/templates/entity-candidate';
import {
  decodeCopilotMetadata,
  type AcceptEntityCandidateResult,
  type EntityCandidateMetadata,
} from '../../../domain/copilot-suggestion';
import { useDataStore } from '../../../store/data-store';
import type {
  CapabilityAcceptContext,
  CapabilityDetectContext,
  CapabilityDetectResult,
  CopilotCapability,
} from '../capability';

const PROMPT_ID = 'entity-candidate';
const PROMPT_VERSION = 1;
/** Drop candidates whose self-reported confidence is below this. */
const CONFIDENCE_THRESHOLD = 0.5;
/**
 * Settings task id — matches the pre-defined CopilotTaskId enum in
 * store/settings-store.ts so the existing copilotTasks list / settings UI
 * surfaces this capability without modification.
 */
const CAPABILITY_ID = 'entityExtract';

export const entityCandidateCapability: CopilotCapability = {
  id: CAPABILITY_ID,
  metadataKind: PROMPT_ID,
  displayName: 'Entity Candidate Detection',
  description:
    'As you write, detect new characters, locations, and items and suggest ' +
    'adding them to your project entity list.',
  trigger: 'editor-block-debounced',

  async detect(ctx: CapabilityDetectContext): Promise<CapabilityDetectResult[]> {
    const context = buildEntityCandidateContext({
      editor: ctx.editor,
      projectId: ctx.projectId,
      focusBlockId: ctx.focusBlockId,
    });
    if (!context) return [];

    const client = await ctx.runtime.getClient();
    const { candidates } = await callStructured(
      client,
      entityCandidatePrompt,
      {
        focusText: context.focusBlock.text,
        surroundingText: [...context.surroundingBlocks]
          .sort((a, b) => a.offset - b.offset)
          .map((b) => b.text)
          .filter(Boolean)
          .join('\n\n'),
        knownNames: context.knownElementNames,
        availableCategories: context.availableCategories,
        rejectedNames: context.rejectedNames,
      },
      { signal: ctx.signal },
    );

    if (ctx.signal.aborted) return [];

    // Post-filter: same lists the model was told to respect, enforced here
    // as defense-in-depth. Pending names are NOT given to the model (they're
    // ephemeral client state); we filter against them here so a fast second
    // trigger doesn't double-suggest the same name.
    const knownSet = new Set(context.knownElementNames);
    const rejectedSet = new Set(context.rejectedNames);
    const pendingSet = collectPendingEntityNames(ctx.projectId);

    const results: CapabilityDetectResult[] = [];
    for (const c of candidates) {
      if (c.confidence < CONFIDENCE_THRESHOLD) {
        log.info(
          `drop (low confidence ${c.confidence.toFixed(2)} < ${CONFIDENCE_THRESHOLD}): "${c.name}"`,
        );
        continue;
      }
      const normalized = c.name.trim().toLowerCase();
      if (!normalized) {
        log.info('drop (empty name after normalize)');
        continue;
      }
      if (knownSet.has(normalized)) {
        log.info(`drop (already known element): "${c.name}"`);
        continue;
      }
      if (rejectedSet.has(normalized)) {
        log.info(`drop (previously rejected by user): "${c.name}"`);
        continue;
      }
      if (pendingSet.has(normalized)) {
        log.info(`drop (already pending in margin): "${c.name}"`);
        continue;
      }
      pendingSet.add(normalized); // in-batch dedup

      const metadata: EntityCandidateMetadata = {
        kind: 'entity-candidate',
        suggestedName: c.name,
        suggestedCategoryHint: c.suggestedCategoryHint,
        evidenceText: c.evidenceText,
        confidence: c.confidence,
        promptId: PROMPT_ID,
        promptVersion: PROMPT_VERSION,
        model: entityCandidatePrompt.model,
      };
      results.push({
        metadata,
        anchorJson: JSON.stringify({ selectedText: c.evidenceText }),
      });
    }
    return results;
  },

  async accept(ctx: CapabilityAcceptContext): Promise<AcceptEntityCandidateResult> {
    if (ctx.metadata.kind !== 'entity-candidate') {
      throw new Error(
        `entity-candidate capability cannot accept metadata of kind "${ctx.metadata.kind}"`,
      );
    }
    const meta = ctx.metadata;

    // Best-effort category match — find a project category whose name
    // matches suggestedCategoryHint (case-insensitive). On miss, fall back
    // to the first available category in the project. createElement requires
    // a non-null categoryId, and we'd rather attach to *some* category than
    // refuse to accept the suggestion.
    const categoryId =
      findCategoryByNameHint(ctx.projectId, meta.suggestedCategoryHint) ??
      pickFallbackCategoryId(ctx.projectId);
    if (!categoryId) {
      throw new Error(
        'No element category exists in this project — create one before accepting Copilot suggestions.',
      );
    }

    const created = await ctx.services.createElement({
      categoryId,
      name: meta.suggestedName,
    });

    // The entity-link auto-detect plugin only fires on docChanged
    // transactions (typed text), so it won't see this element's name in
    // text the user already wrote. Manually scan the editor doc and stamp
    // the entityLink mark on every match — subsequent typing of the same
    // name will then be picked up by the auto-detect on its own.
    if (ctx.editor) {
      try {
        scanAndLinkInDoc(ctx.editor, meta.suggestedName, created.id);
      } catch (err) {
        // Linking failure shouldn't fail the accept — element is still
        // created and discoverable; user can re-type or @-link manually.
        log.warn('[copilot:entity-candidate] scan-and-link failed', err);
      }
    }

    return {
      kind: 'entity-candidate',
      createdElementId: created.id,
    };
  },

  renderSummary(meta) {
    if (meta.kind !== 'entity-candidate') {
      return { title: 'Copilot suggestion' };
    }
    const pct = Math.round(meta.confidence * 100);
    return {
      title: `New ${meta.suggestedCategoryHint}: "${meta.suggestedName}"`,
      subtitle: `${pct}% confident`,
      evidence: meta.evidenceText,
      actionLabel: `Add as ${meta.suggestedCategoryHint}`,
    };
  },
};

/**
 * Find a project category whose name matches the LLM's suggested hint
 * (case-insensitive, trimmed). Returns the category id, or null if no
 * match — which yields an "uncategorized" element. We deliberately don't
 * auto-create a new category from a model hint; that's a structural
 * project change the user should make explicitly.
 */
function findCategoryByNameHint(projectId: string, hint: string): string | null {
  const normalized = hint.trim().toLowerCase();
  if (!normalized) return null;
  const categories = useDataStore.getState().bookElementCategories;
  const match = categories.find(
    (c) => c.projectId === projectId && c.name.trim().toLowerCase() === normalized,
  );
  return match?.id ?? null;
}

/**
 * Fallback for accept(): when no category matches the LLM's hint, pick the
 * first non-deleted category in the project so the new element lands
 * somewhere reasonable. Returns null only if the project genuinely has zero
 * categories — in which case accept will throw with a clear message.
 */
function pickFallbackCategoryId(projectId: string): string | null {
  const categories = useDataStore.getState().bookElementCategories;
  const first = categories.find((c) => c.projectId === projectId);
  return first?.id ?? null;
}

/**
 * Scan the entire editor document for occurrences of `name` and apply the
 * entityLink mark to each match pointing at the newly-created element.
 * Used because the EntityLink plugin's autoDetect only runs on typed text;
 * existing text that mentioned the entity before it was registered would
 * stay un-linked otherwise.
 *
 * Verbatim case-sensitive match — mirrors the autoDetect behavior in
 * lib/extensions/entity-link.ts so the two paths agree on what gets linked.
 * Skips ranges that already carry an entityLink mark pointing at the same
 * (targetKind, targetId).
 */
function scanAndLinkInDoc(editor: Editor, name: string, elementId: string): void {
  const markType = editor.schema.marks.entityLink;
  if (!markType) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const tr = editor.state.tr;
  let modified = false;

  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const text = node.text;
    const regex = new RegExp(escaped, 'g');
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      const from = pos + m.index;
      const to = from + trimmed.length;
      const alreadyLinked = node.marks.some(
        (mark) =>
          mark.type === markType &&
          mark.attrs.targetKind === 'element' &&
          mark.attrs.targetId === elementId,
      );
      if (alreadyLinked) continue;
      tr.addMark(
        from,
        to,
        markType.create({
          targetKind: 'element',
          targetId: elementId,
          targetBlockId: null,
        }),
      );
      modified = true;
    }
  });

  if (!modified) return;
  tr.setMeta('addToHistory', false);
  editor.view.dispatch(tr);
}

/**
 * Names of currently-open copilot entity-candidate suggestions in the
 * project. Read at detect time to avoid re-proposing the same name across
 * back-to-back triggers (the LLM doesn't know about pending suggestions).
 *
 * Lives in the capability (not the framework) because "what counts as a
 * pending duplicate" is capability-specific — element-patch will dedup on
 * `(elementId, fieldPath)`, inline-chat on selection range, etc.
 */
function collectPendingEntityNames(projectId: string): Set<string> {
  const out = new Set<string>();
  for (const comment of useDataStore.getState().manuscriptComments) {
    if (comment.projectId !== projectId) continue;
    if (comment.source !== 'copilot') continue;
    if (comment.status !== 'open') continue;
    const meta = decodeCopilotMetadata(comment.metadataJson);
    if (meta?.kind === 'entity-candidate') {
      out.add(meta.suggestedName.trim().toLowerCase());
    }
  }
  return out;
}
