/**
 * Smoke-test prompt for Phase 0. Exists purely to prove the substrate is
 * wired end-to-end (BYOK/env → Google provider → tool-forced JSON →
 * TypeBox validation). Will be deleted once Phase 1's element-candidate
 * prompt lands.
 */
import { Type } from '@sinclair/typebox';
import { definePrompt } from '../define-prompt';

export const helloWorldPrompt = definePrompt({
  id: 'hello-world',
  version: 1,
  model: 'gemini-3.5-flash',
  description: 'Greet a name and report the language used. Smoke test only.',

  input: Type.Object({
    name: Type.String({ minLength: 1 }),
  }),

  output: Type.Object({
    greeting: Type.String({
      description: 'The greeting itself, in the chosen language.',
    }),
    language: Type.String({
      description: 'ISO 639-1 language code, e.g. "en", "zh", "ja".',
    }),
  }),

  buildSystem: () =>
    'You are a friendly multilingual greeter. For each input, pick a natural language ' +
    'that suits the given name and produce a brief greeting in it.',

  buildUserMessage: (input) =>
    `Greet someone named "${input.name}". Keep the greeting to one sentence.`,
});
