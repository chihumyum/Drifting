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
  AgentModelStopReason,
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
import { OpenAIResponsesAgentDriver } from './openai-responses-driver';

export interface DriftingAgentModelDriverOptions {
  createClient?: () => Promise<AgentCompletionClient | LLMClient>;
  createProviderDriver?: (
    provider: AgentProviderId,
    model: string,
  ) => Promise<AgentModelDriver>;
  defaultModel?: string;
}

/**
 * Lazy product provider router.
 *
 * Credentials are resolved only when the user starts a turn, never while the
 * app boots. A fresh client is built for each turn so replacing or clearing a
 * Keychain entry takes effect immediately. The same instance is retained only
 * across that turn's tool iterations so opaque provider reasoning state can be
 * replayed exactly.
 */
export class DriftingAgentModelDriver implements AgentModelDriver {
  readonly id = 'drifting-provider-router';
  readonly capabilities = {
    reasoning: true,
    context: DRIFTING_AGENT_CONTEXT_PROFILE,
  } as const;

  private readonly createClient: () => Promise<
    AgentCompletionClient | LLMClient
  >;
  private readonly defaultModel: string;
  private readonly createProviderDriver?: DriftingAgentModelDriverOptions['createProviderDriver'];
  private readonly legacyClientOverride: boolean;
  private readonly activeTurnDrivers = new Map<
    string,
    {
      provider: AgentProviderId;
      model: string;
      reasoningKey: string;
      driver: AgentModelDriver;
    }
  >();

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

    const cacheKey = `${request.sessionId}\u0000${request.turnId}`;
    const reasoningKey = `${request.reasoning?.enabled === true}:${
      request.reasoning?.effort ?? ''
    }`;
    const cached = this.activeTurnDrivers.get(cacheKey);
    if (
      cached &&
      (cached.provider !== provider ||
        cached.model !== model ||
        cached.reasoningKey !== reasoningKey)
    ) {
      throw new AgentModelDriverError(
        'The Agent provider, model and reasoning options cannot change inside an active turn.',
      );
    }
    const selected = cached?.driver ?? (await this.createSelectedDriver(provider, model));
    if (!cached) {
      this.activeTurnDrivers.set(cacheKey, {
        provider,
        model,
        reasoningKey,
        driver: selected,
      });
    }

    let stopReason: AgentModelStopReason | undefined;
    try {
      for await (const event of selected.stream({ ...request, provider, model })) {
        if (event.type === 'finish') stopReason = event.reason;
        yield event;
      }
    } finally {
      if (stopReason !== 'tool_use') this.activeTurnDrivers.delete(cacheKey);
    }
  }

  private async createSelectedDriver(
    provider: AgentProviderId,
    model: string,
  ): Promise<AgentModelDriver> {
    try {
      if (this.createProviderDriver) {
        return await this.createProviderDriver(provider, model);
      }
      if (!this.hasLegacyClientOverride() && provider === 'anthropic') {
        const apiKey = await createCredentialChain().getApiKey('anthropic');
        return new AnthropicMessagesAgentDriver({ apiKey, defaultModel: model });
      }
      if (!this.hasLegacyClientOverride() && provider === 'openai') {
        const apiKey = await createCredentialChain().getApiKey('openai');
        return new OpenAIResponsesAgentDriver({ apiKey, defaultModel: model });
      }
      const client: AgentCompletionClient | LLMClient = this.hasLegacyClientOverride()
        ? await this.createClient()
        : await buildGeneralAgentClient({
            logTag: 'general-agent',
            provider,
            model,
          });
      return new OpenAICompatibleCompletionDriver({
        client,
        defaultModel: model,
        id: `${this.id}:${provider}`,
        feature: 'general-agent',
        reasoningMode: provider === 'deepseek' ? 'deepseek' : 'disabled',
      });
    } catch (error) {
      throw clientInitializationError(error, provider);
    }
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
