/**
 * Element-patch capability.
 *
 * Detects state changes about existing entities in the focus paragraph and
 * proposes them as chapter-anchored patches. Accept persists a row to
 * element_patch with the cursor's chapter/block as the anchor.
 *
 * Differs from entity-candidate in two important ways the framework had to
 * accommodate:
 *
 *   1. It MODIFIES an existing entity (creates a side-row on it) rather
 *      than creating a new one. The accept path uses the element_patch
 *      repo directly (no useBookElement involvement).
 *
 *   2. Dedup is by `(elementId, titlePrefix)` rather than by name — many
 *      different patches can target the same entity, so name alone isn't
 *      enough to say "same suggestion".
 *
 * Both differences are absorbed by the framework's existing seams
 * (CopilotCapability.metadataKind discriminator + capability-local pending
 * key construction). No framework code changes were required.
 */
import log from 'loglevel';
import { callStructured } from '../../ai/call-structured';
import {
  buildElementPatchContext,
  pendingKey,
} from '../../ai/context/element-patch-context-builder';
import { elementPatchPrompt } from '../../ai/prompts/templates/element-patch';
import {
  decodeCopilotMetadata,
  type AcceptElementPatchResult,
  type ElementPatchMetadata,
} from '../../../domain/copilot-suggestion';
import { createPlainCommentDoc } from '../../../domain/manuscript-comment';
import { createElementPatchRepository } from '../../../sqlite-repo/element-patch-repo';
import { syncElementPatchCreate } from '../../../usecase/sync-helpers';
import { useDataStore } from '../../../store/data-store';
import type {
  CapabilityAcceptContext,
  CapabilityDetectContext,
  CapabilityDetectResult,
  CopilotCapability,
} from '../capability';

const PROMPT_ID = 'element-patch';
const PROMPT_VERSION = 1;
/** Reject low-confidence patches client-side; matches prompt's stated bar. */
const CONFIDENCE_THRESHOLD = 0.4;
/** Settings task id — matches CopilotTaskId enum (see settings-store). */
const CAPABILITY_ID = 'elementPatch';

export const elementPatchCapability: CopilotCapability = {
  id: CAPABILITY_ID,
  metadataKind: PROMPT_ID,
  displayName: 'Element Patch Proposal',
  description:
    'Detect state changes about existing entities in your prose and propose ' +
    'chapter-anchored patch notes.',
  trigger: 'editor-block-debounced',

  async detect(ctx: CapabilityDetectContext): Promise<CapabilityDetectResult[]> {
    const context = buildElementPatchContext({
      editor: ctx.editor,
      projectId: ctx.projectId,
      focusBlockId: ctx.focusBlockId,
    });
    if (!context) return [];
    // Cheap early exit: nothing to patch against in a project with no
    // elements yet (would just burn tokens for an empty array response).
    if (context.candidateElements.length === 0) return [];

    const client = await ctx.runtime.getClient();
    const { patches } = await callStructured(
      client,
      elementPatchPrompt,
      {
        focusText: context.focusBlock.text,
        surroundingText: [...context.surroundingBlocks]
          .sort((a, b) => a.offset - b.offset)
          .map((b) => b.text)
          .filter(Boolean)
          .join('\n\n'),
        candidateElements: context.candidateElements,
        pendingPatchKeys: context.pendingPatchKeys,
      },
      { signal: ctx.signal },
    );

    if (ctx.signal.aborted) return [];

    // Post-filter: defense in depth (model can lie about elementId or
    // confidence; dedup snapshot may also have drifted since detect started).
    // Each drop is logged at info level so dev console reveals exactly why a
    // model-returned patch didn't surface as a comment — silent drops were
    // the cause of "the model gave me a 0.8 confidence patch but nothing
    // appeared in the margin" head-scratchers.
    const validIds = new Set(context.candidateElements.map((e) => e.id));
    const idToName = new Map(context.candidateElements.map((e) => [e.id, e.name]));
    // Reverse lookup: name OR alias (lowercased) -> id. Lets us recover
    // when the model returns a name/alias in elementId instead of the
    // actual id — observed empirically. Aliases ARE in the lookup so
    // coreference recovery covers "Lady Mira" → mira-id even when the
    // model returns the alias verbatim.
    const nameToId = new Map<string, string>();
    for (const e of context.candidateElements) {
      nameToId.set(e.name.trim().toLowerCase(), e.id);
      for (const alias of e.aliases) {
        const normalized = alias.trim().toLowerCase();
        if (normalized) nameToId.set(normalized, e.id);
      }
    }
    const pendingSet = new Set(context.pendingPatchKeys);

    const out: CapabilityDetectResult[] = [];
    for (const p of patches) {
      if (p.confidence < CONFIDENCE_THRESHOLD) {
        log.info(
          `[copilot:element-patch] drop (low confidence ${p.confidence.toFixed(2)} < ${CONFIDENCE_THRESHOLD}):`,
          { elementId: p.elementId, patchTitle: p.patchTitle },
        );
        continue;
      }
      if (!validIds.has(p.elementId)) {
        // Recovery: the model may have stuffed the entity NAME into elementId
        // instead of the actual uuid (observed empirically with Gemini).
        // Try a case-insensitive name match before giving up.
        const recovered = nameToId.get(p.elementId.trim().toLowerCase());
        if (recovered) {
          log.info(
            `[copilot:element-patch] recover: model returned name "${p.elementId}" → resolved to id ${recovered.slice(0, 8)}`,
          );
          p.elementId = recovered;
        } else {
          log.info(
            `[copilot:element-patch] drop (invented elementId "${p.elementId}" not in candidateElements):`,
            { patchTitle: p.patchTitle, confidence: p.confidence },
          );
          continue;
        }
      }
      const key = pendingKey(p.elementId, p.patchTitle);
      if (pendingSet.has(key)) {
        log.info(
          `[copilot:element-patch] drop (pending dedup key matched "${key}"):`,
          { confidence: p.confidence },
        );
        continue;
      }
      pendingSet.add(key); // in-batch dedup

      const metadata: ElementPatchMetadata = {
        kind: 'element-patch',
        elementId: p.elementId,
        elementName: idToName.get(p.elementId) ?? '(unknown)',
        patchTitle: p.patchTitle,
        patchBody: p.patchBody,
        evidenceText: p.evidenceText,
        confidence: p.confidence,
        promptId: PROMPT_ID,
        promptVersion: PROMPT_VERSION,
        model: elementPatchPrompt.model,
      };
      out.push({
        metadata,
        anchorJson: JSON.stringify({ selectedText: p.evidenceText }),
      });
    }
    return out;
  },

  async accept(ctx: CapabilityAcceptContext): Promise<AcceptElementPatchResult> {
    if (ctx.metadata.kind !== 'element-patch') {
      throw new Error(
        `element-patch capability cannot accept metadata of kind "${ctx.metadata.kind}"`,
      );
    }
    const meta = ctx.metadata;

    // Verify the element still exists — could have been deleted between
    // proposal and accept. Don't ship a dangling patch.
    const exists = useDataStore
      .getState()
      .bookElements.some((e) => e.id === meta.elementId && e.projectId === ctx.projectId);
    if (!exists) {
      throw new Error(
        `Cannot accept patch — element ${meta.elementId} no longer exists in this project.`,
      );
    }

    const repo = createElementPatchRepository();
    const created = await repo.create({
      projectId: ctx.projectId,
      elementId: meta.elementId,
      // The comment anchor IS the chapter + block where Copilot saw the change.
      sourceNodeId: ctx.comment.targetKind === 'node' ? ctx.comment.targetId : null,
      sourceBlockId: ctx.comment.targetBlockId,
      title: meta.patchTitle,
      contentJson: createPlainCommentDoc(meta.patchBody),
    });

    // Enqueue server sync — without this the patch lives only on this
    // device and other devices never see it (the sync hydrate fix in
    // 43db040 prevents local loss but doesn't add upload).
    syncElementPatchCreate(created.id, ctx.projectId, {
      id: created.id,
      elementId: created.elementId,
      sourceNodeId: created.sourceNodeId,
      sourceBlockId: created.sourceBlockId,
      title: created.title,
      contentJson: created.contentJson,
      orderKey: created.orderKey,
    });

    log.info('[copilot:element-patch] created patch', {
      patchId: created.id,
      elementId: meta.elementId,
      title: meta.patchTitle,
    });

    return {
      kind: 'element-patch',
      createdPatchId: created.id,
      elementId: meta.elementId,
    };
  },

  renderSummary(meta) {
    if (meta.kind !== 'element-patch') {
      return { title: 'Copilot suggestion' };
    }
    const pct = Math.round(meta.confidence * 100);
    return {
      title: `Patch ${meta.elementName}: ${meta.patchTitle}`,
      subtitle: `${pct}% confident`,
      // Show body preview in the quote slot rather than raw evidence —
      // the body is what the user is actually accepting.
      evidence: meta.patchBody,
      actionLabel: 'Add patch',
    };
  },

  // collectPendingEntityNames's analogue isn't needed here — the context
  // builder bakes pendingPatchKeys in via decodeCopilotMetadata on
  // metadata.kind === 'element-patch'. Adding a fallback collector that
  // ignores that path would just be dead code.
};

// Marker re-export so the bundler tree-shakes only the helpers we use.
export { decodeCopilotMetadata };
