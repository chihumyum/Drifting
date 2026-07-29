import {
  buildGeneralAgentClient,
} from '../../../ai/client/build-default-client';
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

export interface DriftingAgentModelDriverOptions {
  createClient?: () => Promise<AgentCompletionClient | LLMClient>;
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
  readonly id = 'drifting-deepseek-completion';
  readonly capabilities = { reasoning: false } as const;

  private readonly createClient: () => Promise<
    AgentCompletionClient | LLMClient
  >;
  private readonly defaultModel: string;

  constructor(options: DriftingAgentModelDriverOptions = {}) {
    this.createClient =
      options.createClient ??
      (() => buildGeneralAgentClient({ logTag: 'general-agent' }));
    this.defaultModel = options.defaultModel ?? 'deepseek-v4-flash';
  }

  async *stream(
    request: AgentModelRequest,
  ): AsyncIterable<AgentModelStreamEvent> {
    let client: AgentCompletionClient | LLMClient;
    try {
      client = await this.createClient();
    } catch (error) {
      throw clientInitializationError(error);
    }

    const delegate = new OpenAICompatibleCompletionDriver({
      client,
      defaultModel: this.defaultModel,
      id: this.id,
      feature: 'general-agent',
    });
    yield* delegate.stream(request);
  }
}

function clientInitializationError(error: unknown): AgentModelDriverError {
  if (error instanceof AIError && error.kind === 'auth') {
    return new AgentModelDriverError(
      'General Agent needs a configured DeepSeek API key.',
    );
  }
  return new AgentModelDriverError(
    'General Agent could not initialize its model provider.',
  );
}
