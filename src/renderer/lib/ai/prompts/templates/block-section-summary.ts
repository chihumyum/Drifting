/**
 * Block-section summary prompt — compress a passage of fiction into a
 * dense, patch-aware recall summary that other Copilot capabilities can
 * use as context without re-reading the raw prose.
 *
 * Critical design choice (PR D-1): the summary is NOT a blurb. It's a
 * working memory artifact whose primary consumer is element-patch's
 * "did anything change about an existing entity?" prompt. So it MUST
 * preserve entity state changes verbatim; otherwise downstream patch
 * detection silently misses things that happened in summarized prose.
 *
 * That pushes the prompt away from "1-2 dry sentences" toward "as many
 * sentences as needed to keep every state change". Token cost goes up
 * slightly; element-patch recall stays robust.
 */
import { Type } from '@sinclair/typebox';
import { definePrompt } from '../define-prompt';

export const blockSectionSummaryPrompt = definePrompt({
  id: 'block-section-summary',
  version: 2,
  model: 'gemini-3.5-flash',
  description:
    'Patch-aware summary of a fiction passage. Used as recent-context for ' +
    'element-patch, element-candidate, and other Copilot capabilities.',

  input: Type.Object({
    recentText: Type.String({
      description:
        'The passage to summarize. Concatenated edited blocks the user has ' +
        'just written, in document order. May span 1-30 short paragraphs.',
    }),
  }),

  output: Type.Object({
    summary: Type.String({
      description:
        'A dense factual recap of recentText. Length: 2-5 sentences, more ' +
        'if needed to preserve all state changes. NOT a blurb — the audience ' +
        'is another LLM doing patch detection, not a reader.',
    }),
  }),

  buildSystem: () =>
    'You compress fiction passages into patch-aware recall summaries. Your ' +
    'output is downstream context for AI tools that detect entity state ' +
    'changes — anything you drop, they will miss.\n\n' +
    'STRICT rules:\n' +
    '  1. PRESERVE every entity state change verbatim. If X learned Y, ' +
    'died, gained a possession, changed allegiance, traveled somewhere new, ' +
    'or had a relationship shift — SAY IT in the summary. These are the ' +
    'patches downstream tools need to detect; dropping them defeats the point.\n' +
    '  2. Use the same proper nouns the passage uses. Never paraphrase ' +
    'names — "Bjorn" stays "Bjorn", not "the warrior".\n' +
    '  3. Factual register. Who did what, with what outcome. No flourish, ' +
    'no editorial commentary ("powerfully", "deeply"), no quotes.\n' +
    '  4. Mention setting / location changes ("at the tavern", "outside ' +
    "the gates\") — they're state context for downstream.\n" +
    '  5. Length floor: 2 sentences. Length ceiling: as many as needed to ' +
    'meet rule 1. Err long over short — a missed state change costs more ' +
    'than extra tokens.\n' +
    '  6. If the passage is pure dialogue with no state change ("characters ' +
    'banter at a meal"), one short literal description is fine.',

  buildUserMessage: (input) => `Passage:\n${input.recentText}`,
});
