import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMarkdownProjectionRenderer } from './markdown-projection-client';
import type { LocalRelationalMarkdownSource } from './relational-markdown.local-source';

const source: LocalRelationalMarkdownSource = { books: [], proseByDocId: new Map() };
const now = new Date('2026-10-29T00:00:00Z');
const projection = { entries: [], assets: [], documents: [], documentCount: 0 };
class ProjectionWorker {
  static created: ProjectionWorker[] = [];
  onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void;
  onmessageerror?: () => void;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { ProjectionWorker.created.push(this); }
}
afterEach(() => { vi.unstubAllGlobals(); ProjectionWorker.created = []; });
describe('projection worker lifetime and publication boundary', () => {
  it('keeps one worker and its prose versions across captures until the project closes', async () => {
    vi.stubGlobal('Worker', ProjectionWorker);
    const renderer = createMarkdownProjectionRenderer();
    const controller = new AbortController();
    const first = renderer.render(source, now, controller.signal);
    const [worker] = ProjectionWorker.created;
    expect(worker!.postMessage).toHaveBeenCalledWith({ source, capturedAt: now.toISOString() });
    worker!.onmessage!({ data: { result: projection, proseVersions: new Map([['node:a', '3:t']]) } });
    expect(await first).toBe(projection);
    expect(renderer.knownProseVersions()).toEqual(new Map([['node:a', '3:t']]));

    const second = renderer.render(source, now, controller.signal);
    worker!.onmessage!({ data: { result: projection, proseVersions: new Map([['node:a', '4:t']]) } });
    await second;
    expect(ProjectionWorker.created).toHaveLength(1);
    expect(worker!.terminate).not.toHaveBeenCalled();
    expect(renderer.knownProseVersions()).toEqual(new Map([['node:a', '4:t']]));

    renderer.dispose();
    expect(worker!.terminate).toHaveBeenCalledOnce();
    expect(renderer.knownProseVersions().size).toBe(0);
  });
  it.each(['error', 'messageerror', 'corrupt', 'abort'] as const)('rejects %s, then starts the next capture from nothing', async (failure) => {
    vi.stubGlobal('Worker', ProjectionWorker);
    const renderer = createMarkdownProjectionRenderer();
    const warm = renderer.render(source, now, new AbortController().signal);
    ProjectionWorker.created[0]!.onmessage!({ data: { result: projection, proseVersions: new Map([['node:a', '3:t']]) } });
    await warm;
    const controller = new AbortController();
    const result = renderer.render(source, now, controller.signal);
    const rejection = expect(result).rejects.toThrow();
    const worker = ProjectionWorker.created[0]!;
    if (failure === 'abort') controller.abort();
    else if (failure === 'corrupt') worker.onmessage!({ data: { error: 'Corrupt Yjs' } });
    else if (failure === 'error') worker.onerror!();
    else worker.onmessageerror!();
    await rejection;
    expect(worker.terminate).toHaveBeenCalledOnce();
    // The cache went with the worker: the next capture must carry every document.
    expect(renderer.knownProseVersions().size).toBe(0);
    void renderer.render(source, now, new AbortController().signal);
    expect(ProjectionWorker.created).toHaveLength(2);
    renderer.dispose();
  });
  it('never starts work for a closed project', async () => {
    vi.stubGlobal('Worker', ProjectionWorker);
    const controller = new AbortController(); controller.abort();
    await expect(createMarkdownProjectionRenderer().render(source, now, controller.signal)).rejects.toThrow();
    expect(ProjectionWorker.created).toHaveLength(0);
  });
});
