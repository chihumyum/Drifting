/**
 * Tool-calling stress test for Phase 0. Exercises substrate features that
 * hello-world doesn't:
 *   - Optional fields                  (Type.Optional)
 *   - Integer with min/max             (Type.Integer)
 *   - Array of primitives              (Type.Array)
 *   - Nested object                    (Type.Object inside Type.Object)
 *
 * The point isn't the bio-extraction itself — it's proving the
 * TypeBox → JSON Schema → Gemini function-calling → Value.Check round-trip
 * handles non-trivial shapes. Will be deleted alongside hello-world once
 * Phase 1's real prompts land.
 *
 * Deliberately omitted (push to a later test if needed):
 *   - String enums (Type.Union of Literals) — Gemini's JSON Schema dialect
 *     has historically been picky about anyOf/const forms; want one clean
 *     baseline first.
 */
import { Type } from '@sinclair/typebox';
import { definePrompt } from '../define-prompt';

export const testToolPrompt = definePrompt({
  id: 'test-tool',
  version: 1,
  model: 'gemini-3.5-flash',
  description: 'Extract structured info from a bio. Substrate stress test.',

  input: Type.Object({
    bio: Type.String({ minLength: 10 }),
  }),

  output: Type.Object({
    name: Type.String({
      description: 'Full name as it appears in the bio.',
    }),
    age: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 150,
        description: 'Age in years if mentioned; omit otherwise.',
      }),
    ),
    occupation: Type.String({
      description: 'Single-word occupation if mentioned, e.g. "engineer", "artist".',
    }),
    hobbies: Type.Array(Type.String(), {
      description: 'Hobbies or interests mentioned, deduplicated and lowercased.',
    }),
    location: Type.Optional(
      Type.Object(
        {
          city: Type.String(),
          country: Type.String(),
        },
        { description: 'Where the person lives; omit if not mentioned.' },
      ),
    ),
  }),

  buildSystem: () =>
    'You extract structured information from biographical text. Only include ' +
    'fields the text actually supports — omit optional fields when unsure ' +
    'rather than guessing.',

  buildUserMessage: (input) => `Extract structured info from this bio:\n\n${input.bio}`,
});
