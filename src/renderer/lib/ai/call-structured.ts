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
import { AIError, type AITool, type AIUsage } from './types';

export interface CallStructuredOptions {
  signal?: AbortSignal;
  /** Override the prompt's default model for this single call. */
  model?: string;
  /**
   * Request thinking/reasoning mode for this single call (DeepSeek). NOTE: thinking
   * mode does NOT support forced `tool_choice` (HTTP 400) — so pair it with
   * `jsonMode` (which has no tool_choice), not the default tool path.
   */
  thinking?: boolean;
  /**
   * Use DeepSeek JSON Output (`response_format: json_object`) instead of forced
   * tool-calling: the schema is injected into the prompt and the model returns a
   * valid JSON string as content. This composes with `thinking` (the tool path does
   * not) and DeepSeek guarantees valid JSON, which the prose-heavy structured calls
   * need. Output is still validated against the prompt's TypeBox schema.
   */
  jsonMode?: boolean;
  /** Max output tokens (json mode can truncate large outputs — set generously). */
  maxOutputTokens?: number;
  /**
   * Observe this call's token usage (fired once per `complete()`, after it returns,
   * BEFORE schema validation — so it reflects tokens actually spent even on an
   * attempt that later fails validation). Used for local usage accounting.
   */
  onUsage?: (usage: AIUsage) => void;
  /**
   * Human-readable language name (e.g. "Simplified Chinese (简体中文)") to
   * force the model's natural-language output into, appended to the system
   * prompt. Used for project-level output-language control (Task 1).
   */
  outputLanguage?: string;
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

  // Project-level output-language directive (Task 1): append to the system
  // prompt so natural-language output stays in the manuscript's language
  // regardless of the (English) instruction language.
  let system = prompt.buildSystem?.(input);
  if (options.outputLanguage) {
    const directive =
      `OUTPUT LANGUAGE: Write ALL natural-language output (prose, summaries, ` +
      `descriptions, reasons) in ${options.outputLanguage}, regardless of the ` +
      `language of these instructions or examples. Proper nouns may stay in ` +
      `their original script.`;
    system = system ? `${system}\n\n${directive}` : directive;
  }

  // JSON Output path — used when the caller needs thinking mode (which 400s on the
  // forced-tool-call path). Inject the schema (+ the word "json", required by
  // DeepSeek) into the system prompt; the model returns valid JSON as content, which
  // we still validate against the output schema. Composes with thinking.
  if (options.jsonMode) {
    const schemaText = JSON.stringify(prompt.output);
    const jsonDirective =
      `OUTPUT FORMAT: respond with ONE valid json object — no prose, no markdown ` +
      `fences — conforming exactly to this JSON Schema:\n${schemaText}`;
    const jsonSystem = system ? `${system}\n\n${jsonDirective}` : jsonDirective;
    const jsonRes = await client.complete({
      model: options.model ?? prompt.model,
      system: jsonSystem,
      messages: [{ role: 'user', content: prompt.buildUserMessage(input) }],
      responseFormat: 'json_object',
      thinking: options.thinking,
      maxOutputTokens: options.maxOutputTokens ?? 8192,
      signal: options.signal,
      metadata: { feature: prompt.id, promptId: prompt.id, promptVersion: prompt.version },
    });
    if (jsonRes.usage) options.onUsage?.(jsonRes.usage);
    const raw = (jsonRes.text ?? '').trim();
    if (!raw) {
      throw new AIError('parse', `Prompt "${prompt.id}" (json mode) returned empty content.`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const repaired = repairLooseJson(raw);
      if (repaired === undefined) {
        throw new AIError('parse', `Prompt "${prompt.id}" (json mode) returned invalid JSON.`, {
          raw,
        });
      }
      parsed = repaired;
    }
    if (!Value.Check(prompt.output, parsed)) {
      const errors = [...Value.Errors(prompt.output, parsed)].map(formatError);
      throw new AIError(
        'parse',
        `Prompt "${prompt.id}" (json mode) output failed schema validation:\n${errors.join('\n')}`,
        { parsed },
      );
    }
    return parsed as Static<TOutputSchema>;
  }

  const response = await client.complete({
    model: options.model ?? prompt.model,
    system,
    messages: [{ role: 'user', content: prompt.buildUserMessage(input) }],
    tools: [tool],
    signal: options.signal,
    thinking: options.thinking,
    metadata: {
      feature: prompt.id,
      promptId: prompt.id,
      promptVersion: prompt.version,
    },
  });
  if (response.usage) options.onUsage?.(response.usage);

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

// Best-effort salvage of nearly-valid JSON from json-mode content: strip a ```json
// fence and trailing commas. Returns the parsed value or undefined. (json_object mode
// rarely needs this, but costs nothing on the already-failed path.)
function repairLooseJson(raw: string): unknown {
  let s = raw.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence?.[1]) s = fence[1].trim();
  s = s.replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
