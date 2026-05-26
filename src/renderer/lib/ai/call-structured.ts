/**
 * callStructured — the main entry point used by feature code (Phase 1+).
 *
 * Given a typed `PromptDef` and an input, this helper:
 *   1. Validates input against the prompt's TypeBox schema (fail-fast on bad calls)
 *   2. Hands the output schema directly to Gemini as the function-call
 *      parameters JSON Schema (TypeBox is JSON Schema natively — zero conversion)
 *   3. Forces the model into ANY-mode for that single tool — effectively
 *      coercing schema-conformant JSON output
 *   4. Validates the model's tool-call args against the output schema
 *
 * Theory: Anthropic's "tool use for structured output" pattern, ported to
 * Gemini. We never let the model execute anything in Phase 0/1; the tool is
 * purely a typed JSON channel. Parse-failure retries with feedback will land
 * in a later PR.
 */
import type { Static, TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { LLMClient } from './client/llm-client';
import type { PromptDef } from './prompts/define-prompt';
import { AIError, type AITool } from './types';

export interface CallStructuredOptions {
  signal?: AbortSignal;
  /** Override the prompt's default model for this single call. */
  model?: string;
}

export async function callStructured<
  TInputSchema extends TSchema,
  TOutputSchema extends TSchema,
>(
  client: LLMClient,
  prompt: PromptDef<TInputSchema, TOutputSchema>,
  input: Static<TInputSchema>,
  options: CallStructuredOptions = {},
): Promise<Static<TOutputSchema>> {
  if (!Value.Check(prompt.input, input)) {
    const errors = [...Value.Errors(prompt.input, input)].map(formatError);
    throw new AIError(
      'invalid-input',
      `Prompt "${prompt.id}" input failed validation:\n${errors.join('\n')}`,
    );
  }

  const toolName = prompt.toolName ?? defaultToolName(prompt.id);
  const tool: AITool = {
    name: toolName,
    description: `Return the structured output for "${prompt.id}".`,
    // TypeBox schemas ARE JSON Schema at runtime — pass straight through.
    parametersSchema: prompt.output as unknown as object,
  };

  const response = await client.complete({
    model: options.model ?? prompt.model,
    system: prompt.buildSystem?.(input),
    messages: [{ role: 'user', content: prompt.buildUserMessage(input) }],
    tools: [tool],
    signal: options.signal,
    metadata: {
      feature: prompt.id,
      promptId: prompt.id,
      promptVersion: prompt.version,
    },
  });

  if (!response.toolCall) {
    throw new AIError(
      'parse',
      `Prompt "${prompt.id}" did not produce a tool call. Got text: ${response.text?.slice(0, 200) ?? '<empty>'}`,
    );
  }

  if (response.toolCall.name !== toolName) {
    throw new AIError(
      'parse',
      `Prompt "${prompt.id}" called unexpected tool "${response.toolCall.name}", expected "${toolName}".`,
    );
  }

  const args = response.toolCall.arguments;
  if (!Value.Check(prompt.output, args)) {
    const errors = [...Value.Errors(prompt.output, args)].map(formatError);
    throw new AIError(
      'parse',
      `Prompt "${prompt.id}" output failed schema validation:\n${errors.join('\n')}`,
      { rawArgs: args },
    );
  }

  return args as Static<TOutputSchema>;
}

function defaultToolName(promptId: string): string {
  return `return_${promptId.replace(/[^a-zA-Z0-9]/g, '_')}`;
}

function formatError(e: { path: string; message: string }): string {
  return `  ${e.path || '/'}: ${e.message}`;
}
