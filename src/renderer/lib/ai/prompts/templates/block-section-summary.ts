/**
 * Block-section summary prompt — given a passage the user just wrote,
 * produce one or two sentences capturing what happened, so future Copilot
 * debounces can include it as `priorSections` context without re-feeding
 * raw prose.
 *
 * This is intentionally a SHORT-output prompt. The summary lands in the
 * block_section table and is consumed later by element-patch (and future
 * reverse-outline). Keep it factual and bounded — flowery language wastes
 * tokens both on write and on every subsequent read.
 */
import { Type } from '@sinclair/typebox';
import { definePrompt } from '../define-prompt';

export const blockSectionSummaryPrompt = definePrompt({
  id: 'block-section-summary',
  version: 1,
  model: 'gemini-3.5-flash',
  description:
    'Summarize a short passage of fiction in 1-2 sentences so it can be ' +
    'reused as recent-context for later Copilot calls.',

  input: Type.Object({
    recentText: Type.String({
      description:
        'The text the user just edited (concatenated edited blocks). May be ' +
        '1-30 short paragraphs of fiction.',
    }),
  }),

  output: Type.Object({
    summary: Type.String({
      description:
        'A 1-2 sentence factual summary of what happens in recentText. ' +
        'State who does what, key facts, and the outcome. No flowery prose, ' +
        'no editorial commentary, no quotes — this is context for a model, ' +
        'not a blurb for readers.',
    }),
  }),

  buildSystem: () =>
    'You compress passages of fiction into terse, factual recall summaries ' +
    'used as recent-context for later AI calls.\n\n' +
    'STRICT rules:\n' +
    '  1. 1-2 sentences. Hard cap. No exceptions.\n' +
    '  2. Factual register — who, did what, with what outcome.\n' +
    '  3. Use the same proper nouns the passage uses (do not paraphrase names).\n' +
    "  4. No quotes, no flourish, no editorializing (\"powerfully\", \"deeply\").\n" +
    '  5. If the passage is incoherent / too short / pure dialogue with no ' +
    'state change, return a short literal description ("Dialogue between X and Y.").',

  buildUserMessage: (input) => `Passage:\n${input.recentText}`,
});
