/**
 * Segment-merge prompt (Task 5) — combine several consecutive small rolling
 * segment summaries into ONE denser segment summary. Run when a chapter is
 * finalized and fully covered, so the chapter's working memory isn't a pile
 * of fragmentary one-liners (which also pollute the reverse chapter summary).
 *
 * Output stays in the same working-memory register as block-section-summary
 * (its consumer is patch/candidate detection, not a reader) — so it MUST
 * preserve every entity state change across the merged inputs.
 */
import { Type } from '@sinclair/typebox';
import { definePrompt } from '../define-prompt';

export const segmentMergePrompt = definePrompt({
  id: 'segment-merge',
  version: 1,
  model: 'gemini-2.5-flash',
  description: 'Merge consecutive rolling segment summaries into one denser segment summary.',

  input: Type.Object({
    summaries: Type.Array(Type.String(), {
      description: 'Consecutive segment summaries to merge, in document order.',
    }),
  }),

  output: Type.Object({
    summary: Type.String({
      description:
        'One merged summary that preserves EVERY entity state change, name, ' +
        'and setting change from all inputs. Working-memory register, not a ' +
        'blurb. As long as needed to drop nothing.',
    }),
  }),

  buildSystem: () =>
    'You merge consecutive passage summaries into ONE denser summary for a ' +
    'fiction-writing assistant\'s working memory. PRESERVE every entity state ' +
    'change, proper noun, and setting/location change from all inputs — ' +
    'downstream patch detection relies on them, so dropping any defeats the ' +
    'purpose. Factual register, no flourish, no editorializing.',

  buildUserMessage: (input) =>
    `Summaries to merge (in order):\n` +
    input.summaries.map((s, i) => `  ${i + 1}. ${s}`).join('\n'),
});
