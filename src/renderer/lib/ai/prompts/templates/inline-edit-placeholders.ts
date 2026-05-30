/**
 * inline-edit-placeholders prompt — generate example instructions to show as
 * the inline-edit input placeholder, tailored to THIS project's genre/tone.
 * Two variants: one for when the author has text selected (revise existing
 * prose), one for a bare caret (a local edit at the current paragraph).
 *
 * Cheap, run rarely (cached per project, regenerated weekly). The output is
 * pure UI flavor — never executed — so it just needs to read naturally and
 * stay within the "local edit, no new plot" spirit.
 */
import { Type } from '@sinclair/typebox';
import { definePrompt } from '../define-prompt';

export const inlineEditPlaceholdersPrompt = definePrompt({
  id: 'inline-edit-placeholders',
  version: 1,
  model: 'gemini-2.5-flash',
  description: "Generate genre-tailored example prompts for the inline-edit input placeholder.",

  input: Type.Object({
    projectName: Type.String(),
    projectFacts: Type.String({
      description: 'Project KV facts (genre/tone/references…), newline-joined. May be empty.',
    }),
  }),

  output: Type.Object({
    selectionExamples: Type.Array(Type.String(), {
      description:
        'Example instructions for when the author HAS selected text — about ' +
        'revising the selected prose (polish, fix, tighten, restyle). One ' +
        'sentence each, natural first-person, e.g. "帮我看看这几段有没有语病". 5 items.',
    }),
    blockExamples: Type.Array(Type.String(), {
      description:
        'Example instructions for a bare caret (no selection) — a local edit ' +
        'at the current paragraph, e.g. "在这里加一句环境描写增强紧张感". One ' +
        'sentence each, natural first-person. 5 items.',
    }),
  }),

  buildSystem: () =>
    'You write short example prompts shown as placeholder text in an inline ' +
    'AI prose-editing box for a fiction writer. Tailor them to the project\'s ' +
    'genre and tone. Each example is ONE natural first-person sentence the ' +
    'author might type.\n\n' +
    'Rules:\n' +
    '  1. LOCAL edits only — polish, fix grammar, sharpen a word, adjust tone, ' +
    'add a descriptive clause. NEVER "continue the story / write the next ' +
    'scene / invent a character".\n' +
    '  2. selectionExamples assume text is already selected (revise THIS text). ' +
    'blockExamples assume just a cursor (act on the current paragraph).\n' +
    '  3. Concrete and evocative, fitting the genre — not generic.\n' +
    '  4. Output in the same language as the project facts (Chinese project → ' +
    'Chinese examples).',

  buildUserMessage: (input) =>
    `Project: ${input.projectName}\n` +
    `Facts:\n${input.projectFacts || '(none provided)'}\n\n` +
    `Write 5 selectionExamples and 5 blockExamples tailored to this project.`,
});
