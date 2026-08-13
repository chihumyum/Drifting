/**
 * Chapter-summary prompt — RENDERER STUB (Phase 2).
 *
 * Prose + IP-bearing schema descriptions live on the server
 * The official service maintains an independent implementation. This
 * file holds only a description-free shape for typing + client validation.
 * Bump `version` in lockstep with the server template.
 */
import { Type } from '@sinclair/typebox';
import { defineRemotePrompt } from '../../remote/run-structured';

export const chapterSummaryPrompt = defineRemotePrompt({
  id: 'chapter-summary',
  version: 2,
  model: 'gemini-2.5-flash',

  // v2: prefer the chapter's full prose when small; sectionSummaries is the
  // fallback for an oversized chapter. buildAdaptiveChapterContext picks one.
  input: Type.Object({
    fullChapterText: Type.Optional(Type.String()),
    sectionSummaries: Type.Optional(Type.Array(Type.String())),
  }),

  output: Type.Object({
    summary: Type.String(),
  }),
});
