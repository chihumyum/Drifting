/**
 * Segment-merge prompt — RENDERER STUB (Phase 2).
 *
 * Prose + IP-bearing schema descriptions live on the server
 * (private-service/src/modules/ai/prompts/templates/segment-merge.ts). This
 * file holds only a description-free shape for typing + client validation.
 * Bump `version` in lockstep with the server template.
 */
import { Type } from '@sinclair/typebox';
import { defineRemotePrompt } from '../../remote/run-structured';

export const segmentMergePrompt = defineRemotePrompt({
  id: 'segment-merge',
  version: 1,
  model: 'gemini-2.5-flash',

  input: Type.Object({
    summaries: Type.Array(Type.String()),
  }),

  output: Type.Object({
    summary: Type.String(),
  }),
});
