/**
 * Block inline-edit prompt — RENDERER STUB (Phase 2).
 *
 * Prose + IP-bearing schema descriptions live on the server
 * The official service maintains an independent implementation of this contract.
 * This file holds only a description-free shape for typing + client validation.
 * Bump `version` in lockstep with the server template.
 */
import { Type } from '@sinclair/typebox';
import { defineRemotePrompt } from '../../remote/run-structured';

export const inlineEditBlocksPrompt = defineRemotePrompt({
  id: 'inline-edit-blocks',
  version: 1,
  model: 'gemini-2.5-flash',

  input: Type.Object({
    instruction: Type.String(),
    blocks: Type.Array(
      Type.Object({
        index: Type.Number(),
        kind: Type.String(),
        text: Type.String(),
      }),
    ),
    contextBefore: Type.Optional(Type.String()),
    contextAfter: Type.Optional(Type.String()),
    priorSummaries: Type.Optional(Type.Array(Type.String())),
    allowNewContent: Type.Boolean(),
  }),

  output: Type.Object({
    refused: Type.Boolean(),
    reason: Type.String(),
    blocks: Type.Array(
      Type.Object({
        index: Type.Number(),
        text: Type.String(),
      }),
    ),
  }),
});
