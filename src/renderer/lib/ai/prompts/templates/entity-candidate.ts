/**
 * Entity candidate detection prompt — given a focus paragraph and its
 * surrounding narrative, the model returns zero or more proper nouns that
 * look like entities the user hasn't yet created (new characters, locations,
 * items, etc.).
 *
 * Design notes:
 *  - The model is told the existing element name set so it doesn't propose
 *    duplicates. We additionally filter post-response (defense in depth).
 *  - It's told the project's actual category names so suggestions land in a
 *    real bucket (PR 5 accept flow uses the hint to pick categoryId).
 *  - It's told the user's previously-rejected names — Copilot must respect
 *    "no I already said no to that".
 *  - Confidence is bounded [0, 1]; we'll filter low-confidence ones in the
 *    service layer.
 */
import { Type } from '@sinclair/typebox';
import { definePrompt } from '../define-prompt';

export const entityCandidatePrompt = definePrompt({
  id: 'entity-candidate',
  version: 1,
  model: 'gemini-3.5-flash',
  description:
    'Detect new fictional entities (characters/locations/items) mentioned in ' +
    'a paragraph that are not yet in the project entity list.',

  input: Type.Object({
    recentText: Type.String({
      description:
        'The text the user has recently edited, concatenated newline-separated ' +
        'in document order. May span multiple paragraphs the user touched ' +
        'between Copilot debounces. Scan ALL of it for new entity mentions — ' +
        'not just the last paragraph.',
    }),
    knownNames: Type.Array(Type.String(), {
      description:
        'Names and aliases already in the project entity list (lowercased). ' +
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
    priorSectionSummaries: Type.Array(Type.String(), {
      description:
        'Rolling 1-2-sentence summaries of earlier passages in the same ' +
        'chapter, oldest first. Use them to anchor world / setting / tone ' +
        '(fantasy vs. modern, names of factions and places already in play) ' +
        'so common nouns specific to this setting are not flagged as new ' +
        'entities. Names appearing in these summaries are NOT automatically ' +
        'safe — still cross-check against knownNames before proposing.',
    }),
  }),

  output: Type.Object({
    candidates: Type.Array(
      Type.Object({
        name: Type.String({
          description:
            'The proper noun exactly as it appears in the focus text ' +
            '(preserve capitalization and punctuation).',
        }),
        suggestedCategoryHint: Type.String({
          description:
            'Best-fit category from availableCategories, or a sensible fallback.',
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
            'How confident you are this is a new entity (1 = definitely; 0.5 ' +
            '= ambiguous, could be a common word or a fleeting reference; ' +
            'below 0.3 = probably skip).',
        }),
      }),
      {
        description:
          'Zero or more candidate entities. Return an empty array if the ' +
          'focus text contains no new proper-noun entities.',
      },
    ),
  }),

  buildSystem: () =>
    'You are an entity-extraction assistant for fiction writers. Your job is ' +
    'to scan a passage of recently-written text and find named entities ' +
    '(people, places, things, organizations) that the writer has just ' +
    'introduced but has not yet registered in their project entity list.\n\n' +
    'STRICT rules:\n' +
    '  1. Only propose proper nouns that appear in recentText.\n' +
    '  2. Never propose a name that matches knownNames or rejectedNames ' +
    'case-insensitively.\n' +
    '  3. Common words capitalized for stylistic reasons (e.g. sentence-start ' +
    'words, abstract nouns like "Hope") are NOT entities — skip them.\n' +
    '  4. Pronouns ("he", "she", "they") are NOT entities.\n' +
    '  5. If recentText contains no new entities, return an empty array.\n' +
    '  6. Be conservative — false positives are more annoying than false ' +
    'negatives.',

  buildUserMessage: (input) => {
    const priorSectionLines = input.priorSectionSummaries.length
      ? input.priorSectionSummaries.map((s, idx) => `  ${idx + 1}. ${s}`).join('\n')
      : '  (none — this chapter has no earlier summaries yet)';
    return [
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
