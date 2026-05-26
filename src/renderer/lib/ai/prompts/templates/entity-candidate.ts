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
    focusText: Type.String({
      description: 'The paragraph to scan for new entity mentions.',
    }),
    surroundingText: Type.String({
      description:
        'Text from neighboring paragraphs, joined newline-separated. Provides ' +
        'context to disambiguate proper nouns from common words.',
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
            'A short verbatim excerpt from the focus text containing the name ' +
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
    'to scan a paragraph and find named entities (people, places, things, ' +
    'organizations) that the writer has just introduced but has not yet ' +
    'registered in their project entity list.\n\n' +
    'STRICT rules:\n' +
    '  1. Only propose proper nouns that appear in the focus text.\n' +
    '  2. Never propose a name that matches knownNames or rejectedNames ' +
    'case-insensitively.\n' +
    '  3. Common words capitalized for stylistic reasons (e.g. sentence-start ' +
    'words, abstract nouns like "Hope") are NOT entities — skip them.\n' +
    '  4. Pronouns ("he", "she", "they") are NOT entities.\n' +
    '  5. If the focus text contains no new entities, return an empty array.\n' +
    '  6. Be conservative — false positives are more annoying than false ' +
    'negatives.',

  buildUserMessage: (input) => {
    const ctx = input.surroundingText.trim();
    return [
      ctx ? `Narrative context (surrounding paragraphs):\n${ctx}\n` : '',
      `Focus paragraph to scan:\n${input.focusText}`,
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
