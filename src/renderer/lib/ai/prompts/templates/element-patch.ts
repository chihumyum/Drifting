/**
 * Element-patch detection prompt.
 *
 * Job: read a paragraph + narrative context + the project's element list
 * (with their summaries), and find moments where an EXISTING entity's
 * state has shifted in a way the author should record. The output is a
 * "patch proposal" — a chapter-anchored addendum to the entity, not a
 * mutation of its canonical fields.
 *
 * Examples of what counts as a patch:
 *   - "Bjorn finally trusted Erik" → patch on Bjorn: trust gained
 *   - "the tavern burned down" → patch on Tavern: destroyed
 *   - "Mira learned of her brother's death" → patch on Mira: knowledge state
 *
 * What does NOT count:
 *   - General mentions without state change
 *   - Stylistic flourishes
 *   - Reaffirmations of facts already in the summary
 */
import { Type } from '@sinclair/typebox';
import { definePrompt } from '../define-prompt';

export const elementPatchPrompt = definePrompt({
  id: 'element-patch',
  version: 1,
  model: 'gemini-3.5-flash',
  description:
    'Detect state changes about existing entities in a paragraph and propose ' +
    'chapter-anchored patch addenda.',

  input: Type.Object({
    recentText: Type.String({
      description:
        'The text the user has recently edited, concatenated newline-separated ' +
        'in document order. May span multiple paragraphs the user touched ' +
        'between Copilot debounces. Scan for entity state changes across the ' +
        'whole passage; nearby blocks form coreference / cause context for ' +
        'each other.',
    }),
    candidateElements: Type.Array(
      Type.Object({
        id: Type.String(),
        name: Type.String(),
        aliases: Type.Array(Type.String(), {
          description:
            'Alternate names this entity is referred to by. Treat ANY ' +
            'match against name OR an alias as the same entity — do not ' +
            'propose a new entity just because the text used an alias.',
        }),
        summary: Type.String({ description: 'Current canonical summary; may be empty.' }),
      }),
      {
        description:
          'All entities in this project. Propose patches only against ' +
          'entities listed here — never invent new ids. If the focus text ' +
          'describes an unknown entity, that is entity-extraction territory ' +
          '(a different task), not a patch.',
      },
    ),
    pendingPatchKeys: Type.Array(Type.String(), {
      description:
        'Identifiers of patches already pending in the margin (format: ' +
        '"<elementId>::<short-title-snippet>"). Do not re-propose these.',
    }),
    userInstruction: Type.Optional(
      Type.String({
        description:
          'Optional free-text steer the author typed when manually running ' +
          'this task (e.g. "重点看主角的心理变化"). Empty/absent on automatic ' +
          'runs. When present, bias toward it — but never break the STRICT ' +
          'rules below to satisfy it.',
      }),
    ),
    priorSectionSummaries: Type.Array(Type.String(), {
      description:
        'Rolling 1-2-sentence summaries of earlier passages in the same ' +
        'chapter, oldest first. Treat as already-established history — do ' +
        'NOT propose patches for state changes ALREADY described here ' +
        '(would be reaffirmation, which is explicitly forbidden). DO use ' +
        'them to disambiguate coreference and judge whether a change is ' +
        'genuinely new vs. a continuation.',
    }),
  }),

  output: Type.Object({
    patches: Type.Array(
      Type.Object({
        elementId: Type.String({
          description: 'Must match an id from candidateElements; never invented.',
        }),
        patchTitle: Type.String({
          description:
            'One-line summary of the change in active voice ' +
            '("Bjorn gains trust in Erik", "Tavern destroyed by fire").',
        }),
        patchBody: Type.String({
          description:
            'Two- to three-sentence elaboration the author can edit and ' +
            'attach as a chapter-anchored addendum. Should reference the ' +
            'cause/trigger when present in the text.',
        }),
        evidenceText: Type.String({
          description:
            'Short verbatim excerpt from recentText grounding the patch ' +
            '(<= 160 chars). Used to highlight the chip anchor.',
        }),
        confidence: Type.Number({
          minimum: 0,
          maximum: 1,
          description:
            'How sure you are this is a real, recordable state change. ' +
            'Below 0.4 = probably just a passing mention, skip.',
        }),
      }),
      {
        description:
          'Zero or more patch proposals. Return an empty array if the focus ' +
          'text contains no entity state changes worth recording.',
      },
    ),
  }),

  buildSystem: () =>
    'You are a state-change extractor for fiction writers. Given a paragraph, ' +
    'find moments where an existing entity changes in a way the author should ' +
    'record as an addendum to that entity (a "patch"). Each patch is anchored ' +
    'to the chapter the paragraph belongs to; do not propose patches that ' +
    'would override canonical fields — patches are additive notes.\n\n' +
    'STRICT rules:\n' +
    '  1. elementId must come from candidateElements. Never invent.\n' +
    '  2. Skip mere mentions — only propose when something actually changed.\n' +
    '  3. Skip reaffirmations of facts already in the entity summary.\n' +
    '  4. Skip entries in pendingPatchKeys.\n' +
    '  5. Be conservative — false positives waste the author\'s attention.\n' +
    '  6. If no state changes are present, return an empty array.',

  buildUserMessage: (input) => {
    const elementsList = input.candidateElements.length
      ? input.candidateElements
          .map((e) => {
            const aliasPart = e.aliases.length ? ` (aka ${e.aliases.join(', ')})` : '';
            const summaryPart = e.summary ? ` — ${e.summary}` : '';
            return `  - ${e.id} :: ${e.name}${aliasPart}${summaryPart}`;
          })
          .join('\n')
      : '  (no entities defined in this project — nothing to patch)';
    const priorSectionLines = input.priorSectionSummaries.length
      ? input.priorSectionSummaries.map((s, idx) => `  ${idx + 1}. ${s}`).join('\n')
      : '  (none — this chapter has no earlier summaries yet)';
    const steer = input.userInstruction?.trim();
    return [
      steer ? `Author's steer for this run (honor within the rules): ${steer}` : '',
      `Earlier in this chapter (oldest first; established history — do NOT ` +
        `re-propose patches for changes covered here):\n${priorSectionLines}`,
      '',
      `Recently-edited text (scan for entity state changes):\n${input.recentText}`,
      '',
      `Project entities (id :: name — summary):`,
      elementsList,
      '',
      `Already-pending patches (do NOT re-propose): ${
        input.pendingPatchKeys.length ? input.pendingPatchKeys.join(', ') : '(none)'
      }`,
    ]
      .filter(Boolean)
      .join('\n');
  },
});
