import { DeepSeekProvider } from '../src/renderer/lib/ai/client/providers/deepseek';
import { OpenAIProvider } from '../src/renderer/lib/ai/client/providers/openai';
import { GoogleAIStudioProvider } from '../src/renderer/lib/ai/client/providers/google';
import { buildDirectBYOKClient } from '../src/renderer/lib/ai/client/build-default-client';
import type { LLMProvider } from '../src/renderer/lib/ai/client/providers/provider';
import type { BYOKProvider } from '../src/renderer/lib/byok-keychain';

type Provider = 'deepseek' | 'openai' | 'google';
const instances = new Map<string, LLMProvider>();
const jobs = new Map<string, { controller: AbortController; status: string; result?: unknown; error?: string }>();
const calls: { provider: string; key: string; model: string; stream: boolean }[] = [];
let serial = 0;
const models = { deepseek: 'deepseek-v4-flash', openai: 'gpt-5.6-sol', google: 'gemini-3.5-flash' };
const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!/^https:\/\/(?:api\.openai\.com|api\.deepseek\.com|generativelanguage\.googleapis\.com)\//.test(url)) return originalFetch(input, init);
  const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
  const key = (headers.get('authorization')?.replace(/^Bearer /, '') ?? headers.get('x-goog-api-key') ?? new URL(url).searchParams.get('key'))!;
  if (!key?.startsWith('synthetic-')) throw new Error('Only synthetic credentials may reach this fixture');
  const body = JSON.parse(String(init?.body ?? (input instanceof Request ? await input.text() : '{}')));
  const google = url.includes('googleapis'); const stream = google ? url.includes('streamGenerateContent') : body.stream === true;
  const provider = google ? 'google' : url.includes('deepseek') ? 'deepseek' : 'openai';
  calls.push({ provider, key, model: body.model ?? url.split('/models/')[1]?.split(':')[0], stream });
  const usage = { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 };
  const gemini = { candidates: [{ content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 } };
  const json = google ? gemini : { id: 'synthetic-completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage };
  if (!stream) return new Response(JSON.stringify(json), { headers: { 'content-type': 'application/json' } });
  const chunks = google ? [gemini] : [
    { id: 'synthetic-completion', choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }] },
    { id: 'synthetic-completion', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage },
  ];
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + (google ? '' : 'data: [DONE]\n\n'), { headers: { 'content-type': 'text/event-stream' } });
};
const api = {
  create(provider: Provider, suffix: string) {
    const config = { apiKey: `synthetic-${suffix}`, defaultModel: models[provider] };
    const instance: LLMProvider = provider === 'deepseek' ? new DeepSeekProvider(config) : provider === 'openai' ? new OpenAIProvider(config) : new GoogleAIStudioProvider(config);
    // The old eager constructor snapshots options before returning.
    config.apiKey = 'synthetic-mutated-after-construction';
    instances.set(suffix, instance);
    return { id: instance.id, tools: instance.supportsTools === true, toolStreaming: instance.supportsToolStreaming === true };
  },
  begin(id: string, provider: Provider, stream = false) {
    const key = `job-${++serial}`; const controller = new AbortController();
    const job = { controller, status: 'pending' } as { controller: AbortController; status: string; result?: unknown; error?: string }; jobs.set(key, job);
    const instance = instances.get(id)!;
    const request = { model: models[provider], messages: [{ role: 'user' as const, content: 'Synthetic request' }], signal: controller.signal, thinking: false };
    void (async () => {
      try {
        if (stream) { const chunks = []; for await (const chunk of instance.stream!(request)) chunks.push(chunk); job.result = chunks; }
        else { const value = await instance.complete(request); job.result = { text: value.text, usage: value.usage }; }
        job.status = 'passed';
      } catch (error) { job.status = 'failed'; job.error = (error as { kind?: string }).kind ?? String(error); }
    })();
    return key;
  },
  cancel(key: string) { jobs.get(key)!.controller.abort(); },
  job(key: string) { const job = jobs.get(key)!; return { status: job.status, result: job.result, error: job.error }; },
  calls: () => [...calls],
  online(value: boolean) { Object.defineProperty(navigator, 'onLine', { configurable: true, value }); },
  async factory(provider: Provider) {
    const client = buildDirectBYOKClient(provider as BYOKProvider, `synthetic-factory-${provider}`);
    const result = await client.complete({ model: models[provider], messages: [{ role: 'user', content: 'Synthetic request' }] });
    return { id: client.providerId, text: result.text, usage: result.usage };
  },
};
(globalThis as typeof globalThis & { __DEFERRED_AI__?: typeof api }).__DEFERRED_AI__ = api;
