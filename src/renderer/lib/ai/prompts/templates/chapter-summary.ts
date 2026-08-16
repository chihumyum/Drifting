/**
 * Chapter-summary prompt (Task 5, reverse summary) — turn either the chapter's
 * full prose or its rolling segment summaries into a short, author-facing blurb.
 * Written to BookNode.summary (only when empty). Reader-friendly register,
 * unlike block-section summaries (which are working-memory for other prompts).
 */
import { Type } from '@sinclair/typebox';
import { definePrompt } from '../define-prompt';

export const chapterSummaryPrompt = definePrompt({
  id: 'chapter-summary',
  version: 2,
  model: 'gemini-2.5-flash',
  description:
    "Turn a chapter's full prose or section summaries into one author-facing chapter blurb.",

  input: Type.Object({
    fullChapterText: Type.Optional(
      Type.String({
        description:
          'The complete chapter prose when it fits the local context budget. ' +
          'Preferred over sectionSummaries when present.',
      }),
    ),
    sectionSummaries: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "The chapter's rolling segment summaries, in reading order. Used " +
          'when the complete prose exceeds the local context budget.',
      }),
    ),
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
    'You write a brief chapter summary for a novelist from either the complete ' +
    'chapter prose or its section-by-section notes. Write 2-4 sentences capturing ' +
    'the arc and key beats. Use the same proper nouns as the source. Be factual ' +
    'and readable: no editorializing, no meta commentary, and never invent ' +
    'anything beyond the supplied source.',

  buildUserMessage: (input) => {
    const fullChapterText = input.fullChapterText?.trim();
    if (fullChapterText) return `Complete chapter prose:\n${fullChapterText}`;
    const sectionSummaries = input.sectionSummaries ?? [];
    return (
      `Section notes (in reading order):\n` +
      sectionSummaries.map((summary, index) => `  ${index + 1}. ${summary}`).join('\n')
    );
  },
});
