import { afterEach, expect, it, vi } from 'vitest';
import { DeferredProvider } from './deferred-provider';
import { AIError, type AICompletionRequest } from '../../types';

const request: AICompletionRequest = { model: 'synthetic', messages: [{ role: 'user', content: 'Synthetic only' }] };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const response = { text: 'OK', usage: { inputTokens: 1, outputTokens: 1 } };
  const complete = vi.fn(async () => response);
  const closed = vi.fn();
  const provider = { id: 'synthetic', complete, async *stream() { try { yield { delta: 'A' }; yield { delta: 'B' }; } finally { closed(); } } };
  const create = vi.fn(() => provider);
  const code = deferred<typeof create>();
  const load = vi.fn(() => code.promise);
  class Client extends DeferredProvider { readonly id = 'synthetic'; constructor() { super(load); } }
  return { client: new Client(), Client, code, load, create, complete, closed, response };
}
it('does not load code or create a provider when constructing a facade', () => {
  const f = fixture(); expect(f.load).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled();
});
it.each(['complete', 'stream'] as const)('rejects an already aborted %s without loading', async mode => {
  const f = fixture(); const controller = new AbortController(); controller.abort();
  const req = { ...request, signal: controller.signal };
  await expect(mode === 'complete' ? f.client.complete(req) : f.client.stream(req)[Symbol.asyncIterator]().next()).rejects.toMatchObject({ kind: 'aborted' });
  expect(f.load).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled();
});
it.each(['complete', 'stream'] as const)('cancels %s immediately during loading without late sends', async mode => {
  const f = fixture(); const controller = new AbortController(); const remove = vi.spyOn(controller.signal, 'removeEventListener');
  const req = { ...request, signal: controller.signal };
  const pending = mode === 'complete' ? f.client.complete(req) : f.client.stream(req)[Symbol.asyncIterator]().next();
  const rejected = expect(pending).rejects.toMatchObject({ kind: 'aborted' }); controller.abort(); await rejected;
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  f.code.resolve(f.create); await Promise.resolve(); await Promise.resolve();
  expect(f.create).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
});
it('keeps a concurrent request alive when its peer cancels and constructs just one instance', async () => {
  const f = fixture(); const controller = new AbortController();
  const abandoned = expect(f.client.complete({ ...request, signal: controller.signal })).rejects.toMatchObject({ kind: 'aborted' });
  const active = f.client.complete(request); controller.abort(); await abandoned;
  f.code.resolve(f.create); expect(await active).toBe(f.response);
  expect(f.create).toHaveBeenCalledTimes(1); expect(f.complete).toHaveBeenCalledTimes(1);
  await f.client.complete(request); expect(f.create).toHaveBeenCalledTimes(1); expect(f.load).toHaveBeenCalledTimes(2);
});
it('constructs one instance for two simultaneous successful requests, never sharing instances between facades', async () => {
  const f = fixture(); const second = new f.Client();
  const requests = [f.client.complete(request), f.client.complete(request), second.complete(request)];
  f.code.resolve(f.create); await Promise.all(requests); expect(f.create).toHaveBeenCalledTimes(2);
});
it('rechecks offline capability after loading before constructing or sending', async () => {
  const f = fixture(); vi.stubGlobal('navigator', { onLine: true }); const pending = f.client.complete(request);
  vi.stubGlobal('navigator', { onLine: false }); f.code.resolve(f.create);
  await expect(pending).rejects.toMatchObject({ kind: 'network' }); expect(f.create).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
  vi.stubGlobal('navigator', { onLine: true }); await f.client.complete(request); expect(f.complete).toHaveBeenCalledOnce();
});
it('surfaces a code load failure and lets the next request retry', async () => {
  const f = fixture(); const pending = f.client.complete(request); f.code.reject(new Error('Synthetic failed import'));
  await expect(pending).rejects.toMatchObject({ kind: 'network' }); expect(f.create).not.toHaveBeenCalled();
  f.load.mockResolvedValue(f.create); await f.client.complete(request); expect(f.create).toHaveBeenCalledOnce();
});
it('passes through provider errors and the exact original request/signal', async () => {
  const f = fixture(); f.code.resolve(f.create); const error = new AIError('auth', 'Synthetic rejected key'); f.complete.mockRejectedValue(error);
  const req = { ...request, signal: new AbortController().signal }; await expect(f.client.complete(req)).rejects.toBe(error);
  expect(f.complete).toHaveBeenCalledWith(req);
});
it('forwards iterator return so provider streaming cleanup runs', async () => {
  const f = fixture(); f.code.resolve(f.create); const stream = f.client.stream(request)[Symbol.asyncIterator]();
  expect(await stream.next()).toEqual({ done: false, value: { delta: 'A' } }); await stream.return!(); expect(f.closed).toHaveBeenCalledOnce();
});
it.each(['resolve', 'reject'] as const)('removes the abort listener when code loading settles with %s', async mode => {
  const f = fixture(); const controller = new AbortController(); const remove = vi.spyOn(controller.signal, 'removeEventListener');
  const pending = f.client.complete({ ...request, signal: controller.signal });
  if (mode === 'resolve') { f.code.resolve(f.create); await pending; } else { f.code.reject(new Error('Synthetic load failure')); await expect(pending).rejects.toThrow(); }
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
});
