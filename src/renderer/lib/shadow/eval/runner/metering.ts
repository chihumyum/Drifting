/**
 * MeteringInterceptor — run-level token / cost / latency / failure capture, attached
 * to the judge client via client.use(). after(req,res) is the intended observer hook
 * (interceptor.ts names this exact future use). It keys latency off the req object
 * identity (stable through the chain), so it works under the runner's concurrency
 * WITHOUT touching the execution core.
 *
 * Limit (honest): after(req,res) has no (mutation,chapter,rule) context, so this is
 * RUN-level only. Per-case token attribution needs a separate onUsage bypass threaded
 * through reviewChapter — a deliberate later step, not faked here.
 */
import type { RequestInterceptor } from '../../../ai/interceptors/interceptor';
import type { AICompletionRequest, AICompletionResponse } from '../../../ai/types';
import { costUsd } from './pricing';
import { percentile } from './percentile';

export interface RunMetrics {
  calls: number;
  failures: number;
  failRate: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMeanMs: number;
  latencyP50: number;
  latencyP95: number;
}

export const ZERO_METRICS: RunMetrics = {
  calls: 0,
  failures: 0,
  failRate: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  latencyMeanMs: 0,
  latencyP50: 0,
  latencyP95: 0,
};

export class Metering implements RequestInterceptor {
  private readonly starts = new WeakMap<AICompletionRequest, number>();
  private readonly latencies: number[] = [];
  private calls = 0;
  private failures = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private cost = 0;

  before(req: AICompletionRequest): void {
    this.starts.set(req, Date.now());
  }

  after(req: AICompletionRequest, res: AICompletionResponse): void {
    this.calls += 1;
    const start = this.starts.get(req);
    if (start) this.latencies.push(Date.now() - start);
    const u = res.usage;
    if (u) {
      this.inputTokens += u.inputTokens;
      this.outputTokens += u.outputTokens;
      this.cost += costUsd(req.model, u.inputTokens, u.outputTokens);
    }
  }

  onError(req: AICompletionRequest): void {
    this.calls += 1;
    this.failures += 1;
    const start = this.starts.get(req);
    if (start) this.latencies.push(Date.now() - start);
  }

  snapshot(): RunMetrics {
    const sum = this.latencies.reduce((a, b) => a + b, 0);
    return {
      calls: this.calls,
      failures: this.failures,
      failRate: this.calls ? this.failures / this.calls : 0,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costUsd: this.cost,
      latencyMeanMs: this.latencies.length ? sum / this.latencies.length : 0,
      latencyP50: percentile(this.latencies, 50),
      latencyP95: percentile(this.latencies, 95),
    };
  }
}
