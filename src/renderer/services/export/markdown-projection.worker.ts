import { hydrateInline } from '../../lib/agent/prose-hydrate-client';
import { buildReadableMarkdownProjection } from './readable-markdown-projection';
import type { LocalRelationalMarkdownSource } from './relational-markdown.local-source';

// No database, native bridge or live Y.Doc crosses this boundary. One immutable
// SQLite capture is rendered and hashed in full before native atomic publication.
self.onmessage = async ({ data }: MessageEvent<{ source: LocalRelationalMarkdownSource; capturedAt: string }>) => {
  try {
    const result = await buildReadableMarkdownProjection(data.source, new Date(data.capturedAt), { hydrate: hydrateInline });
    self.postMessage({ result });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
