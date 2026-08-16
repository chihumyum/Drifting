/**
 * Block-structured inline-edit prompt — the multi-block sibling of
 * `inline-edit`. When the author's target spans whole blocks (a multi-block
 * selection, a whole paragraph, or Cmd+A over the chapter), we revise it
 * BLOCK BY BLOCK instead of as one flat string.
 *
 * Why a separate, per-block schema: the old single-`editedText` flow handed
 * back one string and the client had to re-infer block boundaries from `\n`
 * — which silently collapsed many paragraphs into one. Here the model returns
 * exactly one entry per input block (same index, same order, same count), so
 * the block structure is explicit and the client applies each block in place,
 * preserving its type/id. The model literally cannot merge blocks.
 *
 * Same hard constraints as `inline-edit`: local polish only, never invent
 * story content unless the author opted in (allowNewContent).
 */
import { Type } from '@sinclair/typebox';
import { definePrompt } from '../define-prompt';

export const inlineEditBlocksPrompt = definePrompt({
  id: 'inline-edit-blocks',
  version: 1,
  // Interactive (the author is waiting on the result), so the fast model.
  model: 'gemini-2.5-flash',
  description:
    'Local, manual, block-by-block revision of an author-selected multi-block ' +
    'span. Returns one revised block per input block; never collapses blocks ' +
    'and never generates new story content unless opted in.',

  input: Type.Object({
    instruction: Type.String({
      description:
        "The author's short request for this region, e.g. '润色这几段', " +
        "'统一称呼', 'tighten the rhythm', 'fix repetition across paragraphs'.",
    }),
    blocks: Type.Array(
      Type.Object({
        index: Type.Number({ description: '1-based position of this block in the region.' }),
        kind: Type.String({
          description: "Block kind: 'heading' or 'paragraph'. Preserve it — never " +
            'turn a heading into prose or vice versa.',
        }),
        text: Type.String({ description: 'The block\'s current plain text.' }),
      }),
      {
        description:
          'The ordered blocks to revise. You MUST return exactly one output ' +
          'block per input block, with the same index.',
      },
    ),
    contextBefore: Type.Optional(
      Type.String({
        description:
          'Plain text of the blocks immediately ABOVE the region (上文 / what ' +
          'leads INTO it), for local context only (tone, who is speaking, what ' +
          'just happened). Do NOT edit, echo, or return it as a block.',
      }),
    ),
    contextAfter: Type.Optional(
      Type.String({
        description:
          'Plain text of the blocks immediately BELOW the region (下文 / what ' +
          'follows it), for local context only (where the scene is heading). Do ' +
          'NOT edit, echo, or return it as a block.',
      }),
    ),
    priorSummaries: Type.Optional(
      Type.Array(Type.String(), {
        description:
          'Rolling segment summaries near the region — the local narrative arc, ' +
          'for grounding. Context only; do NOT edit or echo.',
      }),
    ),
    allowNewContent: Type.Boolean({
      description:
        'Whether the author has opted into letting inline-edit generate new ' +
        'content. Almost always false — when false, refuse new-content asks.',
    }),
  }),

  output: Type.Object({
    refused: Type.Boolean({
      description:
        'True ONLY when the instruction asks you to generate new story content ' +
        'and allowNewContent is false. Otherwise false.',
    }),
    reason: Type.String({
      description:
        "One short line, in the prose's language. If refused: why. Otherwise: " +
        'what you changed across the region (e.g. "统一了人称，收紧重复修饰").',
    }),
    blocks: Type.Array(
      Type.Object({
        index: Type.Number({
          description: 'The index of the input block this revises. Echo it exactly.',
        }),
        text: Type.String({
          description:
            'The revised block text. If a block needs no change, return it ' +
            'unchanged. Plain text only — no quotes, no markdown, no commentary.',
        }),
      }),
      {
        description:
          'Exactly one entry per input block, SAME indices, SAME order, SAME ' +
          'count. Never merge two blocks into one or split one into two.',
      },
    ),
  }),

  buildSystem: () =>
    'You are a LOCAL prose editor embedded in a fiction-writing app. The author ' +
    'selected a run of their OWN prose, given as an ordered list of blocks, and ' +
    'gave a short instruction. You return a revised version of those blocks.\n\n' +
    'ABSOLUTE constraints:\n' +
    '  1. ONE-TO-ONE BLOCKS. Return exactly one output block per input block, ' +
    'echoing the same index, in the same order. NEVER merge blocks together, ' +
    'NEVER split a block into several. The block count of your output MUST equal ' +
    'the input block count.\n' +
    '  2. LOCAL EDITS ONLY. Fix grammar, tighten phrasing, find a better word, ' +
    'strengthen imagery, fix rhythm, cut repetition — working with the words ' +
    'already there. You polish HOW something is said, never change WHAT happens.\n' +
    '  3. NEVER invent story content: no new plot events, characters, settings, ' +
    'facts, or dialogue meaning not already present in the blocks.\n' +
    '  4. Preserve each block\'s KIND (a heading stays a heading), plus meaning, ' +
    'proper nouns, narrative POV, and tense. Keep each block roughly its original ' +
    'length unless the instruction is about length.\n' +
    '  5. Reply in the SAME LANGUAGE as the prose. Never switch languages.\n' +
    '  6. A block that needs no change must be returned UNCHANGED (same text).\n' +
    '  7. If — and only if — the instruction asks you to GENERATE NEW CONTENT ' +
    '(continue the story, add a scene/paragraph, invent a character/event) AND ' +
    'allowNewContent is false: do NOT comply. Set refused=true, return every ' +
    'block unchanged, and explain briefly in reason.\n' +
    '  8. block.text is plain text ONLY — no quotes, no markdown, no commentary. ' +
    'Put notes in reason.',

  buildUserMessage: (input) => {
    const summaries = (input.priorSummaries ?? []).map((s) => s.trim()).filter(Boolean);
    const before = input.contextBefore?.trim();
    const after = input.contextAfter?.trim();
    // Laid out in narrative order — 上文, then the blocks to revise, then 下文 —
    // so the model reads the target sitting between what precedes and follows it.
    return [
      `[New-content generation: ${input.allowNewContent ? 'PERMITTED' : 'FORBIDDEN'}]`,
      `Instruction: ${input.instruction}`,
      summaries.length
        ? `Story so far — section summaries (context, do not edit):\n` +
          summaries.map((s, i) => `  ${i + 1}. ${s}`).join('\n')
        : '',
      before
        ? `Context ABOVE the selection — 上文 (context only; do NOT edit, echo, ` +
          `or return as a block):\n${before}`
        : '',
      `Blocks to revise (return one entry per block, same index):\n` +
        input.blocks
          .map((b) => `  [${b.index}] (${b.kind}) ${b.text}`)
          .join('\n'),
      after
        ? `Context BELOW the selection — 下文 (context only; do NOT edit, echo, ` +
          `or return as a block):\n${after}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  },
});
