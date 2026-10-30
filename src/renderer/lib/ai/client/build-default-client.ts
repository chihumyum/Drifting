/**
 * BYOK LLM client factories: the General Agent's DeepSeek compatibility client
 * and the direct client behind the Settings connectivity check. Both resolve
 * credentials on the device and never follow a hosted proxy.
 */
import { LLMClient } from './llm-client';
import { DeepSeekProvider } from './providers/deepseek';
import { AnthropicProvider } from './providers/anthropic';
import { OpenAIProvider } from './providers/openai';
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
import { canUseByokProvider } from '../../config';
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

function assertByokNetworkAvailable(): void {
  if (!canUseByokProvider()) {
    throw new AIError('network', 'The selected BYOK provider is unavailable while offline.');
  }
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
