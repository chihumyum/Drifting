/**
 * ServerProxyProvider — L1 adapter that forwards to the Drifting server's AI
 * proxy instead of calling a model SDK directly.
 *
 * Phase 1 of the backend-invocation migration. When VITE_AI_TRANSPORT=proxy,
 * buildDefaultLLMClient swaps this in for the Google/DeepSeek providers, so
 * every LLM call leaves the renderer as a POST to `/api/ai/complete` (carrying
 * the better-auth session cookie via the shared axios apiClient) and the actual
 * provider call — and the API key — lives only on the server. This kills the
 * critical key-theft / network-interception leak.
 *
 * Note for this phase: the prompt is still BUILT in the renderer (callStructured
 * runs here), so prompt TEXT still ships in the bundle until Phase 2 moves the
 * prompt registry server-side. This provider only relocates the key + network.
 *
 * Streaming is intentionally NOT implemented here yet (Phase 5). Without a
 * stream(), LLMClient.stream() falls back to wrapping complete() as a single
 * chunk — so inline-ask still works under the proxy flag, just non-incrementally
 * until the streaming route lands.
 *
 * Error mapping mirrors the server route's status codes back into AIError kinds
 * so the existing retry policy (retry.ts isRetryable: rate-limit + network) and
 * the copilot error UI behave identically to the direct path.
 */
import { apiClient } from '../../../axios-config';
import type { LLMProvider } from './provider';
import {
  AIError,
  type AICompletionRequest,
  type AICompletionResponse,
} from '../../types';

export class ServerProxyProvider implements LLMProvider {
  readonly id = 'server-proxy';
  // The proxy forwards the full AICompletionRequest, so tool-calling rides through
  // it — PROVIDED the server's /api/ai/complete contract accepts the tool fields
  // (toolChoice, role:'tool' results, assistant toolCalls) and returns toolCalls[].
  // That server widening is required for hosted tool loops; until the
  // server ships it, a proxy build's FC loop will 400 on the first tool-result turn.
  readonly supportsTools = true;

  constructor() {
    console.info('[ai] provider=server-proxy (calls go through Drifting server)');
  }

  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    const { signal, ...payload } = request;

    if (signal?.aborted) {
      throw new AIError('aborted', 'Request aborted before send');
    }

    try {
      const res = await apiClient.request<AICompletionResponse>({
        method: 'POST',
        url: '/api/ai/complete',
        data: payload,
        // axios propagates this to fetch/XHR so an upstream cancel actually
        // aborts the in-flight request (and the server aborts the provider).
        signal,
      });
      return res.data;
    } catch (err) {
      throw mapProxyError(err);
    }
  }
}

interface ProxyErrorBody {
  error?: string;
  message?: string;
}

function mapProxyError(err: unknown): AIError {
  if (err instanceof AIError) return err;

  // Axios marks AbortSignal cancellation with code ERR_CANCELED / CanceledError.
  const code = (err as { code?: string } | null)?.code;
  const name = (err as { name?: string } | null)?.name;
  if (code === 'ERR_CANCELED' || name === 'CanceledError') {
    return new AIError('aborted', 'Request aborted', err);
  }

  const response = (err as { response?: { status?: number; data?: ProxyErrorBody } } | null)
    ?.response;
  const status = response?.status;
  const message =
    response?.data?.message || (err instanceof Error ? err.message : String(err));

  // No response at all → transport failure (retryable).
  if (status === undefined) {
    return new AIError('network', message, err);
  }
  if (status === 429) {
    return new AIError('rate-limit', message, err);
  }
  if (status === 400) {
    return new AIError('invalid-input', message, err);
  }
  // 401/403 = session/auth; 503 = server AI not configured / key rejected.
  // All terminal (not retried), surfaced as auth so the UI shows a clear state.
  if (status === 401 || status === 403 || status === 503) {
    return new AIError('auth', message, err);
  }
  // Other 5xx (502 = server-side network/parse/unknown) → retryable network.
  if (status >= 500) {
    return new AIError('network', message, err);
  }
  return new AIError('unknown', message, err);
}
