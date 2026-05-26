/**
 * Public surface of the AI substrate. Feature code (services/copilot,
 * hooks/useCopilot, …) imports from this module; nothing else outside
 * `lib/ai/` should reach into subdirectories.
 */
export * from './types';
export { LLMClient, type LLMClientOptions } from './client/llm-client';
export { GoogleAIStudioProvider, type GoogleProviderConfig } from './client/providers/google';
export type { LLMProvider } from './client/providers/provider';
export { withRetry, DEFAULT_RETRY, type RetryConfig } from './client/retry';
export type { RequestInterceptor } from './interceptors/interceptor';
export { LoggingInterceptor } from './interceptors/logging-interceptor';
export type {
  CredentialsMode,
  CredentialsProvider,
} from './credentials/credentials-provider';
export { BYOKCredentialsProvider } from './credentials/byok';
export { EnvCredentialsProvider } from './credentials/env';
export { ChainCredentialsProvider } from './credentials/chain';
export { definePrompt, type PromptDef } from './prompts/define-prompt';
export { callStructured, type CallStructuredOptions } from './call-structured';
export { installAIDevConsole } from './dev-console';
