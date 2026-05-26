/**
 * LoggingInterceptor — minimal console-tracer for Phase 0. A richer
 * structured logger (writing trace rows to sqlite, attaching trace-id) will
 * land alongside the metering layer in a later PR.
 */
import type { RequestInterceptor } from './interceptor';
import type { AICompletionRequest, AICompletionResponse } from '../types';

export class LoggingInterceptor implements RequestInterceptor {
  constructor(private readonly tag = 'ai') {}

  before(req: AICompletionRequest): void {
    const feature = req.metadata?.feature ?? 'unknown';
    const tools = req.tools?.map((t) => t.name).join(',') ?? '-';
    console.info(`[${this.tag}] → ${feature} model=${req.model} tools=${tools}`);
  }

  after(req: AICompletionRequest, res: AICompletionResponse): void {
    const feature = req.metadata?.feature ?? 'unknown';
    const u = res.usage;
    const cached = u.cachedTokens ? ` cached=${u.cachedTokens}` : '';
    const kind = res.toolCall ? `tool:${res.toolCall.name}` : 'text';
    console.info(
      `[${this.tag}] ← ${feature} ${kind} in=${u.inputTokens} out=${u.outputTokens}${cached}`,
    );
  }

  onError(req: AICompletionRequest, err: unknown): void {
    const feature = req.metadata?.feature ?? 'unknown';
    console.warn(`[${this.tag}] ✗ ${feature}`, err);
  }
}
