/**
 * runStructured — the Phase 2 remote counterpart to callStructured.
 *
 * Instead of building the prompt in the renderer and sending a full request,
 * this sends only (promptId, version, input) to the server's `/api/ai/run`.
 * The server holds the prompt PROSE and the IP-bearing output schema, builds
 * the prompt, calls the model, validates, and returns the structured output.
 * So no prompt text or output-schema descriptions ship in the renderer bundle.
 *
 * The renderer keeps only a DESCRIPTION-FREE shape (`RemotePrompt`) per prompt,
 * used for: (a) the input arg type + output return type via `Static<>`, and
 * (b) cheap fail-fast input validation + defense-in-depth output validation.
 * Field names + value constraints are not IP; the prose and field descriptions
 * are, and those stay on the server.
 *
 * Error mapping mirrors the server route's status codes back to AIError kinds
 * so the existing retry policy + copilot error UI behave like the direct path.
 */
import type { Static, TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { apiClient } from '../../axios-config';
import { AIError } from '../types';
import { aiByokHeaders } from './byok-headers';
import { useSettingsStore } from '../../../store/settings-store';

/** Description-free prompt handle held by the renderer. */
export interface RemotePrompt<TInputSchema extends TSchema, TOutputSchema extends TSchema> {
  id: string;
  version: number;
  model: string;
  /** Input shape — for the typed input arg + client-side fail-fast validation. */
  input: TInputSchema;
  /** Output shape — for the typed return + defense-in-depth validation. */
  output: TOutputSchema;
}

/** Identity helper that gives full input/output inference at definition sites. */
export function defineRemotePrompt<TInputSchema extends TSchema, TOutputSchema extends TSchema>(
  p: RemotePrompt<TInputSchema, TOutputSchema>,
): RemotePrompt<TInputSchema, TOutputSchema> {
  return p;
}

export interface RunStructuredOptions {
  signal?: AbortSignal;
  /** Override the prompt's default model for this call. */
  model?: string;
  /** Project id — the server resolves the output language from synced prefs. */
  projectId?: string;
}

export async function runStructured<TInputSchema extends TSchema, TOutputSchema extends TSchema>(
  prompt: RemotePrompt<TInputSchema, TOutputSchema>,
  input: Static<TInputSchema>,
  options: RunStructuredOptions = {},
): Promise<Static<TOutputSchema>> {
  // Fail-fast on bad input before a round trip. The server re-validates against
  // the enriched schema; this is the same shape, minus descriptions.
  if (!Value.Check(prompt.input, input)) {
    const errors = [...Value.Errors(prompt.input, input)].map(formatError);
    throw new AIError(
      'invalid-input',
      `Prompt "${prompt.id}" input failed validation:\n${errors.join('\n')}`,
    );
  }

  let data: unknown;
  try {
    const configuredModel = useSettingsStore.getState().copilotByokModel.trim();
    const res = await apiClient.request<unknown>({
      method: 'POST',
      url: '/api/ai/run',
      data: {
        promptId: prompt.id,
        promptVersion: prompt.version,
        model: configuredModel || options.model,
        input,
        projectId: options.projectId,
      },
      // Pre-Alpha always requires a transient BYOK key.
      headers: await aiByokHeaders(),
      signal: options.signal,
    });
    data = res.data;
  } catch (err) {
    throw mapRunError(err);
  }

  // Defense-in-depth: shape-validate the server's output against our local shape.
  if (!Value.Check(prompt.output, data)) {
    const errors = [...Value.Errors(prompt.output, data)].map(formatError);
    throw new AIError(
      'parse',
      `Prompt "${prompt.id}" output failed shape validation:\n${errors.join('\n')}`,
    );
  }

  return data as Static<TOutputSchema>;
}

function formatError(e: { path: string; message: string }): string {
  return `  ${e.path || '/'}: ${e.message}`;
}

interface RunErrorBody {
  error?: string;
  message?: string;
}

function mapRunError(err: unknown): AIError {
  if (err instanceof AIError) return err;

  const code = (err as { code?: string } | null)?.code;
  const name = (err as { name?: string } | null)?.name;
  if (code === 'ERR_CANCELED' || name === 'CanceledError') {
    return new AIError('aborted', 'Request aborted', err);
  }

  const response = (err as { response?: { status?: number; data?: RunErrorBody } } | null)
    ?.response;
  const status = response?.status;
  const message = response?.data?.message || (err instanceof Error ? err.message : String(err));

  if (status === undefined) return new AIError('network', message, err);
  if (status === 429) return new AIError('rate-limit', message, err);
  if (status === 400) return new AIError('invalid-input', message, err);
  if (status === 401 || status === 403 || status === 503) return new AIError('auth', message, err);
  if (status >= 500) return new AIError('network', message, err);
  return new AIError('unknown', message, err);
}
