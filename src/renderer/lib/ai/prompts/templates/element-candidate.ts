/**
 * Element candidate detection prompt — scan recently-written text and find
 * proper nouns that look like new BookElements (characters, locations,
 * items, organizations) the user has not yet registered.
 *
 * Naming note: this was `entity-candidate` before PR E. The capability
 * targets BookElement specifically; "entity" in Drifting's vocabulary is
 * the broader 7-way union (node / storyline / element / memo / material /
 * drift / category). Renamed for accuracy.
 *
 * Design notes:
 *  - The model is told the existing element name set so it doesn't propose
 *    duplicates. We additionally filter post-response (defense in depth).
 *  - It's told the project's actual category names so suggestions land in a
 *    real bucket.
 *  - It's told the user's previously-rejected names — Copilot must respect
 *    "no I already said no to that". This is the primary defense against
 *    repeatedly proposing alias-like sub-names (e.g. "杰克" when the user
 *    already has "杰克·汤姆斯"); first rejection ends it forever.
 *  - `initialDescription` is a 1-2 sentence sketch the model writes ONLY
 *    from what recentText reveals. Persisted as element.summary on accept
 *    so a fresh element page already has some content. Empty if nothing in
 *    the text gives the model anything to say beyond the name.
 *  - Confidence is bounded [0, 1]; the capability post-filters below a
 *    threshold to keep low-signal noise out of the margin.
 */
import { Type } from '@sinclair/typebox';
import { definePrompt } from '../define-prompt';

export const elementCandidatePrompt = definePrompt({
  id: 'element-candidate',
  version: 2,
  model: 'gemini-3.5-flash',
  description:
    'Detect new fictional elements (characters/locations/items) mentioned in ' +
    'recently-edited text that are not yet in the project element list.',

  input: Type.Object({
    recentText: Type.String({
      description:
        'The text the user has recently edited, concatenated newline-separated ' +
        'in document order. May span multiple paragraphs the user touched ' +
        'between Copilot debounces. Scan ALL of it for new element mentions — ' +
        'not just the last paragraph.',
    }),
    knownNames: Type.Array(Type.String(), {
      description:
        'Names and aliases already in the project element list (lowercased). ' +
        'Do not propose any name whose lowercased form matches an entry here ' +
        '— that includes alias matches (e.g. if "Lady Mira" is here, do not ' +
        'propose "Mira" as new either).',
    }),
    availableCategories: Type.Array(Type.String(), {
      description:
        'Element categories defined in the project, e.g. ["character", ' +
        '"location"]. Pick the best fit for each candidate from this list. If ' +
        'none fit well, use the lowercased English noun ("character" / ' +
        '"location" / "item" / "organization").',
    }),
    rejectedNames: Type.Array(Type.String(), {
      description:
        'Names the user has explicitly rejected before (lowercased). Never ' +
        'propose these — the user has already said no.',
    }),
    userInstruction: Type.Optional(
      Type.String({
        description:
          'Optional free-text steer the author typed when manually running ' +
          'this task (e.g. "只关注地名", "忽略配角"). Empty/absent on automatic ' +
          'runs. When present, bias your scan toward it — but never break the ' +
          'STRICT rules below to satisfy it.',
      }),
    ),
    priorSectionSummaries: Type.Array(Type.String(), {
      description:
        'Rolling 1-2-sentence summaries of earlier passages in the same ' +
        'chapter, oldest first. Use them to anchor world / setting / tone ' +
        '(fantasy vs. modern, names of factions and places already in play) ' +
        'so common nouns specific to this setting are not flagged as new ' +
        'elements. Names appearing in these summaries are NOT automatically ' +
        'safe — still cross-check against knownNames before proposing.',
    }),
  }),

  output: Type.Object({
    candidates: Type.Array(
      Type.Object({
        name: Type.String({
          description:
            'The proper noun exactly as it appears in recentText ' +
            '(preserve capitalization and punctuation).',
        }),
        suggestedCategoryHint: Type.String({
          description:
            'Best-fit category from availableCategories, or a sensible fallback.',
        }),
        initialDescription: Type.String({
          description:
            'A 1-2 sentence sketch of this element drawn STRICTLY from what ' +
            'recentText says. Examples: "First appears in the tavern scene as ' +
            'a mercenary hired by Bjorn." / "A border town between the ' +
            'kingdom and the wastes; Mira passes through here in chapter 4." ' +
            'NEVER invent details the text does not state. If the text only ' +
            'names the element without saying anything else about them, ' +
            'return an EMPTY string.',
        }),
        evidenceText: Type.String({
          description:
            'A short verbatim excerpt from recentText containing the name ' +
            '(<= 120 chars). Used to highlight the chip anchor in the UI.',
        }),
        confidence: Type.Number({
          minimum: 0,
          maximum: 1,
          description:
            'How confident you are this is a new element (1 = definitely; 0.5 ' +
            '= ambiguous, could be a common word or a fleeting reference; ' +
            'below 0.3 = probably skip).',
        }),
      }),
      {
        description:
          'Zero or more candidate elements. Return an empty array if the ' +
          'recent text contains no new proper-noun elements.',
      },
    ),
  }),

  buildSystem: () =>
    'You are an element-extraction assistant for fiction writers. Your job is ' +
    'to scan a passage of recently-written text and find named elements ' +
    '(people, places, things, organizations) that the writer has just ' +
    'introduced but has not yet registered in their project element list.\n\n' +
    'STRICT rules:\n' +
    '  1. Only propose proper nouns that appear in recentText.\n' +
    '  2. Never propose a name that matches knownNames or rejectedNames ' +
    'case-insensitively.\n' +
    '  3. Common words capitalized for stylistic reasons (e.g. sentence-start ' +
    'words, abstract nouns like "Hope") are NOT elements — skip them.\n' +
    '  4. Pronouns ("he", "she", "they") are NOT elements.\n' +
    '  5. If recentText contains no new elements, return an empty array.\n' +
    '  6. Be conservative — false positives are more annoying than false ' +
    'negatives.\n' +
    '  7. For initialDescription: ONLY use information explicitly stated in ' +
    'recentText. If the text reveals nothing beyond the name, return the ' +
    'empty string — DO NOT INVENT background, age, role, or appearance.',

  buildUserMessage: (input) => {
    const priorSectionLines = input.priorSectionSummaries.length
      ? input.priorSectionSummaries.map((s, idx) => `  ${idx + 1}. ${s}`).join('\n')
      : '  (none — this chapter has no earlier summaries yet)';
    const steer = input.userInstruction?.trim();
    return [
      steer ? `Author's steer for this run (honor within the rules): ${steer}` : '',
      `Earlier in this chapter (oldest first; use for setting / tone / ` +
        `existing-cast context):\n${priorSectionLines}`,
      '',
      `Recently-edited text (scan all of it):\n${input.recentText}`,
      '',
      `Names already known (do NOT propose): ${
        input.knownNames.length ? input.knownNames.join(', ') : '(none)'
      }`,
      `Names previously rejected by user (do NOT propose): ${
        input.rejectedNames.length ? input.rejectedNames.join(', ') : '(none)'
      }`,
      `Available categories: ${
        input.availableCategories.length
          ? input.availableCategories.join(', ')
          : '(none defined — use generic English nouns)'
      }`,
    ]
      .filter(Boolean)
      .join('\n');
  },
});
