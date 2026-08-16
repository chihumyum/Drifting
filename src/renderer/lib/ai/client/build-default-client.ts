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
import { AnthropicProvider } from './providers/anthropic';
import { OpenAIProvider } from './providers/openai';
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
import type { BYOKProvider } from '../../byok-keychain';
import { canUseByokProvider, canUseHostedService } from '../../config';
import type { RequestInterceptor } from '../interceptors/interceptor';

const BYOK_NETWORK_GATE: RequestInterceptor = {
  before: () => {
    assertByokNetworkAvailable();
  },
};

export interface BuildDefaultLLMClientOptions {
  /** Override the logging tag. Defaults to 'ai'. */
  logTag?: string;
  provider?: AgentProviderId;
  model?: string;
}

export interface BuildDirectBYOKClientOptions {
  /** Override the logging tag. Defaults to the provider-specific tag. */
  logTag?: string;
  /** Provider-native model id used as the adapter fallback. */
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
  const proxyTransport = isProxyTransport();
  if (!proxyTransport) assertByokNetworkAvailable();
  const credentials = new ChainCredentialsProvider([
    new EnvCredentialsProvider(),
    new BYOKCredentialsProvider(),
  ]);
  const provider = proxyTransport
    ? new ServerProxyProvider()
    : options.provider
      ? await resolveDirectProvider(options.provider, credentials, options.model)
      : await pickProvider(credentials);

  const client = new LLMClient(provider);
  if (!proxyTransport) client.use(BYOK_NETWORK_GATE);
  client.use(new LoggingInterceptor(options.logTag ?? 'ai'));
  // Dev-only request/response capture: console one-liner via LoggingInterceptor
  // stays; CaptureInterceptor builds the full Markdown trace + writes files
  // to userData/ai-log/. Production builds skip the capture interceptor to
  // avoid disk writes per user request.
  if (runtimeViteEnv.DEV === true) {
    client.use(new CaptureInterceptor({ writeFiles: true }));
  }
  return client;
}

/**
 * Build the author-selected Copilot route. Unlike the compatibility factory,
 * this never guesses from whichever key happens to exist and never follows the
 * hosted proxy flag. Local-first Copilot is explicit BYOK on the device.
 */
export async function buildCopilotLLMClient(
  provider: BYOKProvider,
  options: Omit<BuildDefaultLLMClientOptions, 'provider'> = {},
): Promise<LLMClient> {
  assertByokNetworkAvailable();
  const credentials = new ChainCredentialsProvider([
    new EnvCredentialsProvider(),
    new BYOKCredentialsProvider(),
  ]);
  const apiKey = await tryGetKey(credentials, provider);
  if (!apiKey) {
    throw new AIError(
      'auth',
      `No ${provider} key is configured. Add one in Settings → Models & API.`,
    );
  }
  return buildDirectBYOKClient(provider, apiKey, {
    ...options,
    logTag: options.logTag ?? 'copilot',
  });
}

/**
 * Build a direct client from one explicitly supplied provider credential.
 * This is used by the author-triggered Settings connectivity check as well as
 * deterministic tests; only the BYOK network capability applies.
 */
export function buildDirectBYOKClient(
  provider: BYOKProvider,
  apiKey: string,
  options: BuildDirectBYOKClientOptions = {},
): LLMClient {
  assertByokNetworkAvailable();
  if (!apiKey.trim()) throw new AIError('auth', `${provider} API key is empty.`);
  return wrapClient(
    createDirectProvider(provider, apiKey, options.model),
    options.logTag ?? `${provider}-byok`,
  );
}

function createDirectProvider(provider: BYOKProvider, apiKey: string, model?: string): LLMProvider {
  switch (provider) {
    case 'deepseek':
      return new DeepSeekProvider({
        apiKey,
        ...(model ? { defaultModel: model } : {}),
        thinking: false,
      });
    case 'google':
      return new GoogleAIStudioProvider({ apiKey });
    case 'anthropic':
      return new AnthropicProvider({
        apiKey,
        ...(model ? { defaultModel: model } : {}),
      });
    case 'openai':
      return new OpenAIProvider({
        apiKey,
        ...(model ? { defaultModel: model } : {}),
      });
  }
}

async function resolveDirectProvider(
  provider: BYOKProvider,
  credentials: ChainCredentialsProvider,
  model?: string,
): Promise<LLMProvider> {
  const apiKey = await tryGetKey(credentials, provider);
  if (!apiKey) {
    throw new AIError(
      'auth',
      `No ${provider} key is configured. Add one in Settings → Models & API.`,
    );
  }
  return createDirectProvider(provider, apiKey, model);
}

function wrapClient(provider: LLMProvider, logTag: string): LLMClient {
  const client = new LLMClient(provider)
    .use(BYOK_NETWORK_GATE)
    .use(new LoggingInterceptor(logTag));
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
  assertByokNetworkAvailable();
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
  return runtimeViteEnv.VITE_AI_TRANSPORT === 'proxy' && canUseHostedService();
}

function assertByokNetworkAvailable(): void {
  if (!canUseByokProvider()) {
    throw new AIError('network', 'The selected BYOK provider is unavailable while offline.');
  }
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
  provider: BYOKProvider,
): Promise<string | null> {
  try {
    return await credentials.getApiKey(provider);
  } catch {
    return null;
  }
}
