import {
  buildGeneralAgentClient,
} from '../../../ai/client/build-default-client';
import { ChainCredentialsProvider } from '../../../ai/credentials/chain';
import { EnvCredentialsProvider } from '../../../ai/credentials/env';
import { BYOKCredentialsProvider } from '../../../ai/credentials/byok';
import type { LLMClient } from '../../../ai/client/llm-client';
import { AIError } from '../../../ai/types';
import { AgentModelDriverError } from '../errors';
import type {
  AgentModelDriver,
  AgentModelRequest,
  AgentModelStreamEvent,
} from '../types';
import {
  type AgentCompletionClient,
  OpenAICompatibleCompletionDriver,
} from './openai-compatible-completion-driver';
import { DRIFTING_AGENT_CONTEXT_PROFILE } from '../drifting-agent-product-contract';
import {
  agentProviderOption,
  isAgentProviderId,
  normalizeAgentProviderModel,
  type AgentProviderId,
} from '../agent-provider-contract';
import { AnthropicMessagesAgentDriver } from './anthropic-messages-driver';

export interface DriftingAgentModelDriverOptions {
  createClient?: () => Promise<AgentCompletionClient | LLMClient>;
  createProviderDriver?: (
    provider: AgentProviderId,
    model: string,
  ) => Promise<AgentModelDriver>;
  defaultModel?: string;
}

/**
 * Lazy product driver for P1.
 *
 * Credentials are resolved only when the user starts a turn, never while the
 * app boots. A fresh client is built for each turn so replacing or clearing a
 * Keychain entry takes effect immediately and an old secret is not retained by
 * a long-lived provider instance.
 */
export class DriftingAgentModelDriver implements AgentModelDriver {
  readonly id = 'drifting-provider-router';
  readonly capabilities = {
    reasoning: false,
    context: DRIFTING_AGENT_CONTEXT_PROFILE,
  } as const;

  private readonly createClient: () => Promise<
    AgentCompletionClient | LLMClient
  >;
  private readonly defaultModel: string;
  private readonly createProviderDriver?: DriftingAgentModelDriverOptions['createProviderDriver'];
  private readonly legacyClientOverride: boolean;

  constructor(options: DriftingAgentModelDriverOptions = {}) {
    this.createClient = options.createClient ?? defaultCreateClient;
    this.legacyClientOverride = options.createClient !== undefined;
    this.defaultModel = options.defaultModel ?? 'deepseek-v4-flash';
    this.createProviderDriver = options.createProviderDriver;
  }

  async *stream(
    request: AgentModelRequest,
  ): AsyncIterable<AgentModelStreamEvent> {
    const provider = request.provider ?? 'deepseek';
    if (!isAgentProviderId(provider)) {
      throw new AgentModelDriverError('The selected Agent provider is not certified.');
    }
    const model = normalizeAgentProviderModel(
      provider,
      request.model ?? (provider === 'deepseek' ? this.defaultModel : undefined),
    );
    if (
      request.model &&
      !agentProviderOption(provider).models.some((candidate) => candidate.value === request.model)
    ) {
      throw new AgentModelDriverError(
        'The selected model does not belong to the selected Agent provider.',
      );
    }

    if (this.createProviderDriver) {
      let selected: AgentModelDriver;
      try {
        selected = await this.createProviderDriver(provider, model);
      } catch (error) {
        throw clientInitializationError(error, provider);
      }
      yield* selected.stream({ ...request, provider, model });
      return;
    }

    if (!this.hasLegacyClientOverride() && provider === 'anthropic') {
      let apiKey: string;
      try {
        apiKey = await createCredentialChain().getApiKey('anthropic');
      } catch (error) {
        throw clientInitializationError(error, provider);
      }
      const selected = new AnthropicMessagesAgentDriver({ apiKey, defaultModel: model });
      yield* selected.stream({ ...request, provider, model });
      return;
    }

    let client: AgentCompletionClient | LLMClient;
    try {
      client = this.hasLegacyClientOverride()
        ? await this.createClient()
        : await buildGeneralAgentClient({
            logTag: 'general-agent',
            provider,
            model,
          });
    } catch (error) {
      throw clientInitializationError(error, provider);
    }

    const delegate = new OpenAICompatibleCompletionDriver({
      client,
      defaultModel: model,
      id: `${this.id}:${provider}`,
      feature: 'general-agent',
    });
    yield* delegate.stream({ ...request, provider, model });
  }

  private hasLegacyClientOverride(): boolean {
    return this.legacyClientOverride;
  }
}

const defaultCreateClient = () => buildGeneralAgentClient({ logTag: 'general-agent' });

function createCredentialChain(): ChainCredentialsProvider {
  return new ChainCredentialsProvider([
    new EnvCredentialsProvider(),
    new BYOKCredentialsProvider(),
  ]);
}

function clientInitializationError(
  error: unknown,
  provider: AgentProviderId,
): AgentModelDriverError {
  if (error instanceof AIError && error.kind === 'auth') {
    return new AgentModelDriverError(
      `General Agent needs a configured ${agentProviderOption(provider).label} API key.`,
    );
  }
  return new AgentModelDriverError(
    'General Agent could not initialize its model provider.',
  );
}
