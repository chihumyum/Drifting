/**
 * Default LLM client factory.
 *
 * Multi-provider routing: prefers DeepSeek when its key is configured
 * (cheaper + currently has friendlier rate limits than the Gemini free
 * tier), falls back to Google. Decision is taken at first-call time so the
 * user can flip providers by adding/removing env vars without restarting
 * the dev server.
 *
 * Settings-driven provider selection (rather than env-driven) is a Phase 6
 * follow-up; until then the env key is the single source of truth.
 */
import { LLMClient } from './llm-client';
import { GoogleAIStudioProvider } from './providers/google';
import { DeepSeekProvider } from './providers/deepseek';
import { BYOKCredentialsProvider } from '../credentials/byok';
import { EnvCredentialsProvider } from '../credentials/env';
import { ChainCredentialsProvider } from '../credentials/chain';
import { LoggingInterceptor } from '../interceptors/logging-interceptor';
import { CaptureInterceptor } from '../interceptors/capture-interceptor';
import type { LLMProvider } from './providers/provider';
import { AIError } from '../types';

export interface BuildDefaultLLMClientOptions {
  /** Override the logging tag. Defaults to 'ai'. */
  logTag?: string;
}

export async function buildDefaultLLMClient(
  options: BuildDefaultLLMClientOptions = {},
): Promise<LLMClient> {
  const credentials = new ChainCredentialsProvider([
    new EnvCredentialsProvider(),
    new BYOKCredentialsProvider(),
  ]);

  // Try DeepSeek first — it's the path the user explicitly opted into when
  // they set their key, and current rate limits are friendlier than the
  // Gemini free tier. Fall back to Google otherwise.
  const provider = await pickProvider(credentials);
  const client = new LLMClient(provider).use(new LoggingInterceptor(options.logTag ?? 'ai'));
  // Dev-only request/response capture: console one-liner via LoggingInterceptor
  // stays; CaptureInterceptor builds the full Markdown trace + writes files
  // to userData/ai-log/. Production builds skip the capture interceptor to
  // avoid disk writes per user request.
  if (import.meta.env.DEV) {
    client.use(new CaptureInterceptor({ writeFiles: true }));
  }
  return client;
}

async function pickProvider(credentials: ChainCredentialsProvider): Promise<LLMProvider> {
  const deepseekKey = await tryGetKey(credentials, 'deepseek');
  if (deepseekKey) {
    const thinking = readDeepSeekThinkingFlag();
    const reasoningEffort = readDeepSeekReasoningEffort();
    console.info(
      `[ai] provider=deepseek thinking=${thinking}${
        thinking && reasoningEffort ? ` effort=${reasoningEffort}` : ''
      } (key present, takes precedence)`,
    );
    return new DeepSeekProvider({
      apiKey: deepseekKey,
      thinking,
      reasoningEffort,
    });
  }

  const googleKey = await tryGetKey(credentials, 'google');
  if (googleKey) {
    console.info('[ai] provider=google (gemini)');
    return new GoogleAIStudioProvider({ apiKey: googleKey });
  }

  throw new AIError(
    'auth',
    'No AI provider credentials configured. Set VITE_DEEPSEEK_AI_API_KEY or VITE_GOOGLE_AI_API_KEY, or configure a key in Settings → Models & API.',
  );
}

const TRUTHY = new Set(['1', 'true', 'enabled', 'on', 'yes']);

function readDeepSeekThinkingFlag(): boolean {
  const raw = import.meta.env.VITE_DEEPSEEK_THINKING;
  if (typeof raw !== 'string') return false;
  return TRUTHY.has(raw.trim().toLowerCase());
}

function readDeepSeekReasoningEffort(): 'high' | 'max' | undefined {
  const raw = import.meta.env.VITE_DEEPSEEK_REASONING_EFFORT;
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'high' || normalized === 'max') return normalized;
  return undefined;
}

async function tryGetKey(
  credentials: ChainCredentialsProvider,
  provider: 'deepseek' | 'google',
): Promise<string | null> {
  try {
    return await credentials.getApiKey(provider);
  } catch {
    return null;
  }
}
