/**
 * Inline-edit prompt — RENDERER STUB (Phase 2).
 *
 * Prose + IP-bearing schema descriptions live on the server
 * (private-service/src/modules/ai/prompts/templates/inline-edit.ts). This file
 * holds only a description-free shape for typing + client validation. Bump
 * `version` in lockstep with the server template.
 */
import { Type } from '@sinclair/typebox';
import { defineRemotePrompt } from '../../remote/run-structured';

export const inlineEditPrompt = defineRemotePrompt({
  id: 'inline-edit',
  version: 2,
  model: 'gemini-2.5-flash',

  input: Type.Object({
    instruction: Type.String(),
    selectedText: Type.String(),
    blockContext: Type.String(),
    contextBefore: Type.Optional(Type.String()),
    contextAfter: Type.Optional(Type.String()),
    priorSummaries: Type.Optional(Type.Array(Type.String())),
    allowNewContent: Type.Boolean(),
  }),

  output: Type.Object({
    editedText: Type.String(),
    refused: Type.Boolean(),
    reason: Type.String(),
  }),
});
