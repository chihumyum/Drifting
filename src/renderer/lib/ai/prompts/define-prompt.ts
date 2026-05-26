/**
 * Prompt registry framework — every Copilot feature defines its prompt as a
 * typed `PromptDef`. Treating prompts as code (versioned, typed, in their
 * own files) is the practice that lets us:
 *   - Run eval suites against a specific prompt version
 *   - A/B test new prompts safely
 *   - Avoid `string` -> wrong-shape `unknown` round-trips at call sites
 *
 * Schema layer: TypeBox. A TypeBox schema **is** a JSON Schema object at
 * runtime, so the same declaration powers (a) TS type inference via
 * `Static<...>`, (b) runtime validation via `Value.Check`, and (c) Gemini
 * function-calling parameters — no schema-to-schema conversion needed.
 *
 * We share TypeBox with the Elysia server, so a Drifting engineer only has
 * to learn one schema dialect across the stack.
 */
import type { Static, TSchema } from '@sinclair/typebox';
import type { GoogleModel } from '../types';

export interface PromptDef<TInputSchema extends TSchema, TOutputSchema extends TSchema> {
  /** Stable kebab-case id. Used in metering, eval, and as the default tool name. */
  id: string;
  /** Bump when changing prompt text or schema. Eval reports keyed by id+version. */
  version: number;
  /** Default model for this prompt. Caller can override at call time later. */
  model: GoogleModel;
  /** One-line human-readable description. Shown in dev UI. */
  description: string;

  input: TInputSchema;
  output: TOutputSchema;

  /** Build the system prompt. Optional — pure-user prompts skip this. */
  buildSystem?: (input: Static<TInputSchema>) => string;
  buildUserMessage: (input: Static<TInputSchema>) => string;

  /**
   * Function-call tool name. If omitted, derived as `return_<id_with_underscores>`.
   * Gemini ANY-mode forces a call to this tool, which is how we coerce
   * schema-conformant JSON output.
   */
  toolName?: string;
}

/**
 * Identity function with a strongly-typed signature — exists so `definePrompt`
 * sites get full input/output inference without callers needing to write the
 * generics explicitly.
 */
export function definePrompt<
  TInputSchema extends TSchema,
  TOutputSchema extends TSchema,
>(def: PromptDef<TInputSchema, TOutputSchema>): PromptDef<TInputSchema, TOutputSchema> {
  return def;
}
