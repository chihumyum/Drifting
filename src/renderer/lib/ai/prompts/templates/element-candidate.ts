/**
 * Element-candidate prompt — RENDERER STUB (Phase 2).
 *
 * The prompt PROSE (buildSystem/buildUserMessage) and the IP-bearing schema
 * field descriptions have moved to the server
 * (private-service/src/modules/ai/prompts/templates/element-candidate.ts).
 * This file now holds ONLY a description-free shape: field names + value
 * constraints, used for the typed input arg, the typed return, and cheap
 * client-side validation. Nothing here reveals how the extraction works.
 *
 * Bump `version` in lockstep with the server template — the server rejects a
 * mismatched version so a stale client can't send a wrong-shape input.
 */
import { Type } from '@sinclair/typebox';
import { defineRemotePrompt } from '../../remote/run-structured';

export const elementCandidatePrompt = defineRemotePrompt({
  id: 'element-candidate',
  version: 2,
  model: 'gemini-3.5-flash',

  input: Type.Object({
    recentText: Type.String(),
    knownNames: Type.Array(Type.String()),
    availableCategories: Type.Array(Type.String()),
    rejectedNames: Type.Array(Type.String()),
    userInstruction: Type.Optional(Type.String()),
    priorSectionSummaries: Type.Array(Type.String()),
  }),

  output: Type.Object({
    candidates: Type.Array(
      Type.Object({
        name: Type.String(),
        suggestedCategoryHint: Type.String(),
        initialDescription: Type.String(),
        evidenceText: Type.String(),
        confidence: Type.Number({ minimum: 0, maximum: 1 }),
      }),
    ),
  }),
});
