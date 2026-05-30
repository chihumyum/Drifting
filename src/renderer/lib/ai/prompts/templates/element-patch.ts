/**
 * Element-patch prompt — RENDERER STUB (Phase 2).
 *
 * Prose + IP-bearing schema descriptions live on the server
 * (private-service/src/modules/ai/prompts/templates/element-patch.ts). This
 * file holds only a description-free shape for typing + client validation.
 * Bump `version` in lockstep with the server template.
 */
import { Type } from '@sinclair/typebox';
import { defineRemotePrompt } from '../../remote/run-structured';

export const elementPatchPrompt = defineRemotePrompt({
  id: 'element-patch',
  version: 1,
  model: 'gemini-3.5-flash',

  input: Type.Object({
    recentText: Type.String(),
    candidateElements: Type.Array(
      Type.Object({
        id: Type.String(),
        name: Type.String(),
        aliases: Type.Array(Type.String()),
        summary: Type.String(),
      }),
    ),
    pendingPatchKeys: Type.Array(Type.String()),
    userInstruction: Type.Optional(Type.String()),
    priorSectionSummaries: Type.Array(Type.String()),
  }),

  output: Type.Object({
    patches: Type.Array(
      Type.Object({
        elementId: Type.String(),
        patchTitle: Type.String(),
        patchBody: Type.String(),
        evidenceText: Type.String(),
        confidence: Type.Number({ minimum: 0, maximum: 1 }),
      }),
    ),
  }),
});
