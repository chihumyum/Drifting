/**
 * Chapter-summary prompt (Task 5, reverse summary) — roll the chapter's
 * rolling segment summaries up into one short, author-facing chapter blurb.
 * Written to BookNode.summary (only when empty). Reader-friendly register,
 * unlike block-section summaries (which are working-memory for other prompts).
 */
import { Type } from '@sinclair/typebox';
import { definePrompt } from '../define-prompt';

export const chapterSummaryPrompt = definePrompt({
  id: 'chapter-summary',
  version: 1,
  model: 'gemini-2.5-flash',
  description: "Roll a chapter's section summaries up into one author-facing chapter blurb.",

  input: Type.Object({
    sectionSummaries: Type.Array(Type.String(), {
      description: "The chapter's rolling segment summaries, in reading order.",
    }),
  }),

  output: Type.Object({
    summary: Type.String({
      description:
        'A concise chapter summary (2-4 sentences) capturing the arc and key ' +
        'beats — what an author would recognize as the gist. Plain prose, no ' +
        'headings, no lists.',
    }),
  }),

  buildSystem: () =>
    'You write a brief chapter summary for a novelist, from the chapter\'s ' +
    'section-by-section notes. 2-4 sentences capturing the arc and the key ' +
    'beats. Use the same proper nouns the notes use. Factual and readable — ' +
    'no editorializing, no meta commentary, do not invent beyond the notes.',

  buildUserMessage: (input) =>
    `Section notes (in reading order):\n` +
    input.sectionSummaries.map((s, i) => `  ${i + 1}. ${s}`).join('\n'),
});
