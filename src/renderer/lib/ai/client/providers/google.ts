/**
 * Google AI Studio provider — L1 adapter for the `@google/genai` SDK.
 *
 * This is the only file in the substrate that knows the SDK exists. Above
 * here, everything talks in our provider-agnostic AI* shapes (see ../types).
 *
 * Phase 0 supports non-streaming `generateContent` with optional function
 * calling forced to ANY-mode for structured output. Streaming will be added
 * in Phase 2 (Inline Chat).
 */
import { GoogleGenAI } from '@google/genai';
import type { LLMProvider } from './provider';
import {
  AIError,
  type AICompletionRequest,
  type AICompletionResponse,
  type AIToolCall,
} from '../../types';

export interface GoogleProviderConfig {
  apiKey: string;
}

export class GoogleAIStudioProvider implements LLMProvider {
  readonly id = 'google-ai-studio';
  private readonly client: GoogleGenAI;

  constructor(config: GoogleProviderConfig) {
    this.client = new GoogleGenAI({ apiKey: config.apiKey });
  }

  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    const { model, system, messages, tools, maxOutputTokens, temperature, signal } = request;

    // Pre-flight abort check — fail fast if the caller already cancelled.
    if (signal?.aborted) {
      throw new AIError('aborted', 'Request aborted before send');
    }

    const contents = messages.map((m) => ({
      role: m.role,
      parts: [{ text: m.content }],
    }));

    // SDK accepts a free-shaped `config`; we narrow to what we use.
    const config: Record<string, unknown> = {};
    if (system) config.systemInstruction = system;
    if (typeof temperature === 'number') config.temperature = temperature;
    if (typeof maxOutputTokens === 'number') config.maxOutputTokens = maxOutputTokens;

    if (tools && tools.length > 0) {
      config.tools = [
        {
          functionDeclarations: tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parametersSchema,
          })),
        },
      ];
      // ANY mode + a single allowed name == "you must call this function". This
      // is how we coerce Gemini into producing schema-conformant JSON output.
      config.toolConfig = {
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: tools.map((t) => t.name),
        },
      };
    }

    try {
      const completionPromise = this.client.models.generateContent({
        model,
        contents,
        config,
      });

      const response = signal
        ? await raceAbort(completionPromise, signal)
        : await completionPromise;

      const usage = (response as unknown as { usageMetadata?: GoogleUsage }).usageMetadata;
      const functionCalls =
        (response as unknown as { functionCalls?: GoogleFunctionCall[] }).functionCalls ?? [];

      const toolCall: AIToolCall | undefined = functionCalls[0]
        ? {
            name: functionCalls[0].name ?? 'unknown',
            arguments: functionCalls[0].args ?? {},
          }
        : undefined;

      // Only read .text when there are no function calls. The SDK's `.text`
      // getter prints a noisy warning when the response is purely function
      // calls (our ANY-mode default), and we'd discard the result anyway.
      const text =
        functionCalls.length === 0
          ? (response as unknown as { text?: string }).text
          : undefined;

      return {
        text: typeof text === 'string' ? text : undefined,
        toolCall,
        usage: {
          inputTokens: usage?.promptTokenCount ?? 0,
          outputTokens: usage?.candidatesTokenCount ?? 0,
          cachedTokens: usage?.cachedContentTokenCount,
        },
        raw: response,
      };
    } catch (err) {
      throw mapGoogleError(err);
    }
  }
}

interface GoogleUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
}

interface GoogleFunctionCall {
  name?: string;
  args?: unknown;
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AIError('aborted', 'Request aborted'));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

function mapGoogleError(err: unknown): AIError {
  if (err instanceof AIError) return err;

  if (err instanceof DOMException && err.name === 'AbortError') {
    return new AIError('aborted', 'Request was aborted', err);
  }

  const errObj = err as Record<string, unknown> | null | undefined;
  const status =
    (typeof errObj?.status === 'number' && errObj.status) ||
    (typeof errObj?.statusCode === 'number' && errObj.statusCode) ||
    (typeof errObj?.code === 'number' && errObj.code) ||
    null;
  const message = err instanceof Error ? err.message : String(err);

  if (status === 401 || status === 403) {
    return new AIError('auth', `Authentication failed: ${message}`, err);
  }
  if (status === 429) {
    return new AIError('rate-limit', `Rate limit hit: ${message}`, err);
  }
  if (typeof status === 'number' && status >= 500) {
    return new AIError('network', `Upstream error ${status}: ${message}`, err);
  }
  if (err instanceof TypeError) {
    return new AIError('network', message, err);
  }
  return new AIError('unknown', message, err);
}
