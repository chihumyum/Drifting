import { buildReadableMarkdownProjection } from './readable-markdown-projection';
import { ProseJsonCache } from './relational-markdown.prose';
import type { LocalRelationalMarkdownSource } from './relational-markdown.local-source';

type Projection = Awaited<ReturnType<typeof buildReadableMarkdownProjection>>;

export interface MarkdownProjectionRenderer {
  /** Yjs versions whose prose the renderer holds; a capture may omit their bytes. */
  knownProseVersions(): ReadonlyMap<string, string>;
  render(source: LocalRelationalMarkdownSource, now: Date, signal: AbortSignal): Promise<Projection>;
  /** Release the worker and every parsed document. */
  dispose(): void;
}

/**
 * One project's renderer. Its worker and hydrated prose live until the project
 * closes. Worker failures reject and drop the cache, so the next capture is
 * complete; a partial or stale projection must never be published.
 */
export function createMarkdownProjectionRenderer(): MarkdownProjectionRenderer {
  let worker: Worker | null = null;
  let known: ReadonlyMap<string, string> = new Map();
  // Without a Worker (tests, non-browser hosts) the cache lives here.
  const inline = new ProseJsonCache();
  const reset = () => {
    worker?.terminate();
    worker = null;
    known = new Map();
    inline.clear();
  };
  return {
    knownProseVersions: () => known,
    async render(source, now, signal) {
      signal.throwIfAborted();
      if (typeof Worker === 'undefined') {
        try {
          const result = await buildReadableMarkdownProjection(source, now, {
            proseCache: inline,
            yieldToMain: async () => {
              await new Promise(resolve => setTimeout(resolve, 0));
              signal.throwIfAborted();
            },
          });
          known = inline.versions();
          return result;
        } catch (error) { reset(); throw error; }
      }
      const current = worker ??= new Worker(new URL('./markdown-projection.worker.ts', import.meta.url), { type: 'module' });
      try {
        const { result, proseVersions } = await new Promise<{ result: Projection; proseVersions: Map<string, string> }>((resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
          const finish = () => signal.removeEventListener('abort', abort);
          current.onmessage = ({ data }: MessageEvent<{ result: Projection; proseVersions: Map<string, string>; error?: string }>) => {
            finish();
            if (data.error !== undefined) reject(new Error(data.error));
            else resolve(data);
          };
          current.onerror = () => { finish(); reject(new Error('Markdown projection worker failed')); };
          current.onmessageerror = () => { finish(); reject(new Error('Invalid Markdown projection worker response')); };
          try { current.postMessage({ source, capturedAt: now.toISOString() }); }
          catch (error) { finish(); reject(error); }
        });
        known = proseVersions;
        return result;
      } catch (error) { reset(); throw error; }
    },
    dispose: reset,
  };
}
