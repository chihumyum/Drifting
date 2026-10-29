import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderMarkdownProjection } from './markdown-projection-client';
import type { LocalRelationalMarkdownSource } from './relational-markdown.local-source';

const source: LocalRelationalMarkdownSource = { books: [], proseByDocId: new Map() };
const now = new Date('2026-10-29T00:00:00Z');
class ProjectionWorker {
  static latest: ProjectionWorker;
  onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void;
  onmessageerror?: () => void;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { ProjectionWorker.latest = this; }
}
afterEach(() => vi.unstubAllGlobals());
describe('projection worker lifetime and publication boundary', () => {
  it('returns one complete result for the exact capture, then releases the worker', async () => {
    vi.stubGlobal('Worker', ProjectionWorker);
    const controller = new AbortController();
    const result = renderMarkdownProjection(source, now, controller.signal);
    const worker = ProjectionWorker.latest;
    expect(worker.postMessage).toHaveBeenCalledWith({ source, capturedAt: now.toISOString() });
    const projection = { entries: [], assets: [], documents: [], documentCount: 0 };
    worker.onmessage!({ data: { result: projection } });
    expect(await result).toBe(projection);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(source.proseByDocId.size).toBe(0);
  });
  it.each(['error', 'messageerror', 'corrupt', 'abort'] as const)('rejects %s without returning partial or fallback prose', async (failure) => {
    vi.stubGlobal('Worker', ProjectionWorker);
    const controller = new AbortController();
    const result = renderMarkdownProjection(source, now, controller.signal);
    const rejection = expect(result).rejects.toThrow();
    const worker = ProjectionWorker.latest;
    if (failure === 'abort') controller.abort();
    else if (failure === 'corrupt') worker.onmessage!({ data: { error: 'Corrupt Yjs' } });
    else if (failure === 'error') worker.onerror!();
    else worker.onmessageerror!();
    await rejection;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it('never starts work for a closed project', async () => {
    vi.stubGlobal('Worker', ProjectionWorker);
    const controller = new AbortController(); controller.abort();
    await expect(renderMarkdownProjection(source, now, controller.signal)).rejects.toThrow();
  });
});
