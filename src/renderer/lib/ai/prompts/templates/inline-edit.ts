/**
 * Inline-edit prompt — the ONLY Copilot prompt that touches the prose the
 * author is actively writing. It is deliberately, aggressively constrained:
 * it revises a small span the author selected, following a short instruction
 * ("fix the grammar", "find a better word", "strengthen the synesthesia"),
 * and it must NOT generate new story content.
 *
 * Why so locked down: inline-edit runs WITHOUT the project / chapter /
 * storyline context the rest of Copilot assembles (it's a fast, local,
 * manual call). Letting it write new plot here would produce content that
 * contradicts the worldbuilding the author hasn't shown it. So new-content
 * generation is refused unless the author explicitly opts in
 * (copilotInlineEditAllowNewContent) and accepts that quality trade-off.
 *
 * The `refused` output channel lets the model decline a new-content request
 * gracefully (with a reason) instead of either complying or erroring. A
 * cheap client-side pre-filter (see lib/copilot/inline-edit.ts) catches the
 * unambiguous "continue the story" asks before we even spend a model call;
 * the model handles the nuanced ones.
 */
import { Type } from '@sinclair/typebox';
import { definePrompt } from '../define-prompt';

export const inlineEditPrompt = definePrompt({
  id: 'inline-edit',
  version: 2,
  // Interactive (the author is waiting on the result), so the fast model.
  model: 'gemini-2.5-flash',
  description:
    'Local, manual revision of an author-selected prose span. Polishes how ' +
    'something is said; never generates new story content unless opted in.',

  input: Type.Object({
    instruction: Type.String({
      description:
        "The author's short request for this span, e.g. '修复语病', " +
        "'换个更准的动词', 'strengthen the synesthesia', 'tighten this'.",
    }),
    selectedText: Type.String({
      description: 'The exact prose span to revise. Your output replaces this.',
    }),
    blockContext: Type.String({
      description:
        'The enclosing paragraph/block, for context only. Do NOT rewrite ' +
        'it — it tells you what the selected span is doing in its sentence.',
    }),
    contextBefore: Type.Optional(
      Type.String({
        description:
          'Plain text of the blocks ABOVE the target (上文 / what leads into it), ' +
          'for local context only (tone, who is speaking, what just happened). ' +
          'Do NOT edit or echo it.',
      }),
    ),
    contextAfter: Type.Optional(
      Type.String({
        description:
          'Plain text of the blocks BELOW the target (下文 / what follows it), ' +
          'for local context only (where the scene is heading). Do NOT edit or ' +
          'echo it.',
      }),
    ),
    priorSummaries: Type.Optional(
      Type.Array(Type.String(), {
        description:
          'Rolling segment summaries near the target — the local narrative ' +
          'arc, for grounding. Context only; do NOT edit or echo.',
      }),
    ),
    allowNewContent: Type.Boolean({
      description:
        'Whether the author has opted into letting inline-edit generate new ' +
        'content. Almost always false — when false, refuse new-content asks.',
    }),
  }),

  output: Type.Object({
    editedText: Type.String({
      description:
        'The revised span — your replacement for selectedText. Same language ' +
        'as the input prose. No quotes, no markdown, no commentary. If you ' +
        'refuse (see refused), return selectedText unchanged here.',
    }),
    refused: Type.Boolean({
      description:
        'True ONLY when the instruction asks you to generate new story ' +
        'content and allowNewContent is false. Otherwise false.',
    }),
    reason: Type.String({
      description:
        'One short line, in the prose\'s language. If refused: why. ' +
        'Otherwise: what you changed (e.g. "收紧了重复的修饰语").',
    }),
  }),

  buildSystem: () =>
    'You are a LOCAL prose editor embedded in a fiction-writing app. The ' +
    'author selects a small span of their OWN prose and gives a short ' +
    'instruction. You return a revised version of ONLY that span.\n\n' +
    'ABSOLUTE constraints:\n' +
    '  1. LOCAL EDITS ONLY. Fix grammar, tighten phrasing, find a better ' +
    'word, strengthen imagery/synesthesia, fix rhythm, cut repetition — ' +
    'working with the words already there. You polish HOW something is ' +
    'said, never change WHAT happens.\n' +
    '  2. NEVER invent story content: no new plot events, characters, ' +
    'settings, facts, or dialogue meaning that are not already in the ' +
    'selected text or its enclosing paragraph.\n' +
    '  3. Preserve meaning, proper nouns, narrative POV, and tense. Keep ' +
    'roughly the same length unless the instruction is itself about length.\n' +
    '  4. Reply in the SAME LANGUAGE as the selected text. Chinese prose → ' +
    'Chinese editedText. Never switch languages.\n' +
    '  5. If — and only if — the instruction asks you to GENERATE NEW ' +
    'CONTENT (continue the story, write what happens next, add a scene or ' +
    'paragraph, invent a character/event) AND allowNewContent is false: do ' +
    'NOT comply. Set refused=true, return selectedText unchanged as ' +
    'editedText, and explain briefly in reason. When allowNewContent is ' +
    'true you may comply, but stay as minimal as the instruction allows.\n' +
    '  6. editedText is the revised span ONLY — no quotes, no markdown, no ' +
    'commentary. Put notes in reason.',

  buildUserMessage: (input) => {
    const summaries = (input.priorSummaries ?? []).map((s) => s.trim()).filter(Boolean);
    const before = input.contextBefore?.trim();
    const after = input.contextAfter?.trim();
    const enclosing = input.blockContext?.trim();
    // Narrative order — 上文, then the enclosing paragraph holding the span,
    // then 下文 — so the span reads in place between what precedes and follows.
    return [
      `[New-content generation: ${input.allowNewContent ? 'PERMITTED' : 'FORBIDDEN'}]`,
      `Instruction: ${input.instruction}`,
      summaries.length
        ? `Story so far — section summaries (context, do not edit):\n` +
          summaries.map((s, i) => `  ${i + 1}. ${s}`).join('\n')
        : '',
      before ? `Context ABOVE — 上文 (context only, do NOT edit or echo):\n${before}` : '',
      enclosing
        ? `Enclosing paragraph — the span sits inside this; do not rewrite the ` +
          `whole paragraph:\n${enclosing}`
        : '',
      `Text to revise:\n${input.selectedText}`,
      after ? `Context BELOW — 下文 (context only, do NOT edit or echo):\n${after}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  },
});
