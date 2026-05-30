/**
 * Block-section summary prompt — RENDERER STUB (Phase 2).
 *
 * Prose + IP-bearing schema descriptions live on the server
 * (private-service/src/modules/ai/prompts/templates/block-section-summary.ts).
 * This file holds only a description-free shape for typing + client validation.
 * Bump `version` in lockstep with the server template.
 */
import { Type } from '@sinclair/typebox';
import { defineRemotePrompt } from '../../remote/run-structured';

export const blockSectionSummaryPrompt = defineRemotePrompt({
  id: 'block-section-summary',
  version: 2,
  model: 'gemini-3.5-flash',

  input: Type.Object({
    recentText: Type.String(),
  }),

  output: Type.Object({
    summary: Type.String(),
  }),
});
