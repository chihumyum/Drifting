/**
 * Default LLM client factory.
 *
 * Multi-provider routing: prefers DeepSeek when its key is configured
 * (cheaper + currently has friendlier rate limits than the Gemini free
 * tier), falls back to Google. Decision is taken at first-call time so the
 * user can flip providers by adding/removing env vars without restarting
 * the dev server.
 *
 * Feature-specific factories below use explicit settings routes. This generic
 * compatibility factory still prefers the first available development credential.
 */
import { LLMClient } from './llm-client';
import { GoogleAIStudioProvider } from './providers/google';
import { DeepSeekProvider } from './providers/deepseek';
import { ServerProxyProvider } from './providers/server-proxy';
import { BYOKCredentialsProvider } from '../credentials/byok';
import { EnvCredentialsProvider } from '../credentials/env';
import { ChainCredentialsProvider } from '../credentials/chain';
import { LoggingInterceptor } from '../interceptors/logging-interceptor';
import { CaptureInterceptor } from '../interceptors/capture-interceptor';
import type { LLMProvider } from './providers/provider';
import { AIError } from '../types';
import type { AgentProviderId } from '../../agent/runtime/agent-provider-contract';
import { runtimeViteEnv } from '../../vite-runtime-env';

export interface BuildDefaultLLMClientOptions {
  /** Override the logging tag. Defaults to 'ai'. */
  logTag?: string;
  provider?: AgentProviderId;
  model?: string;
}

export async function buildDefaultLLMClient(
  options: BuildDefaultLLMClientOptions = {},
): Promise<LLMClient> {
  // Phase 1 of the backend-invocation migration: when VITE_AI_TRANSPORT=proxy,
  // route every LLM call through the Drifting server (which holds the hosted
  // key) instead of calling a provider SDK directly from the renderer. This is
  // the SOLE behavioral change that flips the substrate to the proxy —
  // callStructured, capabilities, prompts, retry, and interceptors are all
  // untouched. The credentials chain is built (and a key read) ONLY on the
  // direct path, so proxy builds never pull a key into the renderer.
  const provider = isProxyTransport()
    ? new ServerProxyProvider()
    : await pickProvider(
        new ChainCredentialsProvider([new EnvCredentialsProvider(), new BYOKCredentialsProvider()]),
      );

  const client = new LLMClient(provider).use(new LoggingInterceptor(options.logTag ?? 'ai'));
  // Dev-only request/response capture: console one-liner via LoggingInterceptor
  // stays; CaptureInterceptor builds the full Markdown trace + writes files
  // to userData/ai-log/. Production builds skip the capture interceptor to
  // avoid disk writes per user request.
  if (runtimeViteEnv.DEV === true) {
    client.use(new CaptureInterceptor({ writeFiles: true }));
  }
  return client;
}

function wrapClient(provider: LLMProvider, logTag: string): LLMClient {
  const client = new LLMClient(provider).use(new LoggingInterceptor(logTag));
  if (runtimeViteEnv.DEV === true) client.use(new CaptureInterceptor({ writeFiles: true }));
  return client;
}

/**
 * General Agent P1 client.
 *
 * The Agent is a renderer-local runtime and must keep BYOK credentials on the
 * device. It therefore never follows the global proxy build flag. This
 * compatibility factory is DeepSeek-only. Anthropic and OpenAI use their
 * native Messages/Responses Agent drivers so provider reasoning state can be
 * replayed exactly across tool rounds.
 */
export async function buildGeneralAgentClient(
  options: BuildDefaultLLMClientOptions = {},
): Promise<LLMClient> {
  const credentials = new ChainCredentialsProvider([
    new EnvCredentialsProvider(),
    new BYOKCredentialsProvider(),
  ]);
  const provider = options.provider ?? 'deepseek';
  if (provider !== 'deepseek') {
    throw new AIError(
      'invalid-input',
      `${provider} uses a native Agent driver, not the OpenAI-compatible client.`,
    );
  }
  return buildDirectDeepSeekClient(options, credentials);
}

async function buildDirectDeepSeekClient(
  options: BuildDefaultLLMClientOptions,
  credentials = new ChainCredentialsProvider([
    new EnvCredentialsProvider(),
    new BYOKCredentialsProvider(),
  ]),
): Promise<LLMClient> {
  const apiKey = await tryGetKey(credentials, 'deepseek');
  if (!apiKey) {
    throw new AIError(
      'auth',
      'No deepseek key is configured for General Agent. Add one in Settings → Models & API.',
    );
  }
  return wrapClient(
    new DeepSeekProvider({
      apiKey,
      ...(options.model ? { defaultModel: options.model } : {}),
      thinking: false,
    }),
    options.logTag ?? 'general-agent',
  );
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

/**
 * Whether to route LLM calls through the server proxy (Phase 1). Build-time
 * flag — flip per build by setting VITE_AI_TRANSPORT=proxy. Defaults to the
 * direct-to-provider path so existing builds are unchanged.
 */
export function isProxyTransport(): boolean {
  return runtimeViteEnv.VITE_AI_TRANSPORT === 'proxy';
}

const TRUTHY = new Set(['1', 'true', 'enabled', 'on', 'yes']);

function readDeepSeekThinkingFlag(): boolean {
  const raw = runtimeViteEnv.VITE_DEEPSEEK_THINKING;
  if (typeof raw !== 'string') return false;
  return TRUTHY.has(raw.trim().toLowerCase());
}

function readDeepSeekReasoningEffort(): 'high' | 'max' | undefined {
  const raw = runtimeViteEnv.VITE_DEEPSEEK_REASONING_EFFORT;
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'high' || normalized === 'max') return normalized;
  return undefined;
}

async function tryGetKey(
  credentials: ChainCredentialsProvider,
  provider: import('../../byok-keychain').BYOKProvider,
): Promise<string | null> {
  try {
    return await credentials.getApiKey(provider);
  } catch {
    return null;
  }
}
