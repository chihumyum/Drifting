import { buildReadableMarkdownProjection } from './readable-markdown-projection';
import type { LocalRelationalMarkdownSource } from './relational-markdown.local-source';

type Projection = Awaited<ReturnType<typeof buildReadableMarkdownProjection>>;

/** A capture owns its worker, so closing a project releases all parsed prose.
 * Worker failures reject; a partial or stale projection must never be published. */
export async function renderMarkdownProjection(
  source: LocalRelationalMarkdownSource,
  now: Date,
  signal: AbortSignal,
): Promise<Projection> {
  signal.throwIfAborted();
  if (typeof Worker === 'undefined') {
    return buildReadableMarkdownProjection(source, now, { yieldToMain: async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
      signal.throwIfAborted();
    } });
  }
  const worker = new Worker(new URL('./markdown-projection.worker.ts', import.meta.url), { type: 'module' });
  try {
    return await new Promise<Projection>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      const finish = () => signal.removeEventListener('abort', abort);
      worker.onmessage = ({ data }: MessageEvent<{ result: Projection; error?: string }>) => {
        finish();
        if (data.error !== undefined) reject(new Error(data.error));
        else resolve(data.result);
      };
      worker.onerror = () => { finish(); reject(new Error('Markdown projection worker failed')); };
      worker.onmessageerror = () => { finish(); reject(new Error('Invalid Markdown projection worker response')); };
      try { worker.postMessage({ source, capturedAt: now.toISOString() }); }
      catch (error) { finish(); reject(error); }
    });
  } finally { worker.terminate(); }
}
