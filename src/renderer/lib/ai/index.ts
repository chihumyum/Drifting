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

// L4 Context layer — for feature code that wants to assemble prompts itself.
export type { BlockSnippet, EntityCandidateContext } from './context/types';
export {
  buildEntityCandidateContext,
  type BuildEntityCandidateContextInput,
} from './context/entity-candidate-context-builder';
export {
  extractBlockContext,
  getBlockIdAtCursor,
  type BlockContextResult,
  type ExtractBlockContextOptions,
} from './context/selectors/block-context';
export {
  getKnownElementNames,
  getAvailableCategoryNames,
  getRejectedSuggestionNames,
} from './context/selectors/elements';

// Prompts — re-exported so feature code can pass them to callStructured.
export { entityCandidatePrompt } from './prompts/templates/entity-candidate';
