import { hydrateInline } from '../../lib/agent/prose-hydrate-client';
import { buildReadableMarkdownProjection } from './readable-markdown-projection';
import { ProseJsonCache } from './relational-markdown.prose';
import type { LocalRelationalMarkdownSource } from './relational-markdown.local-source';

// No database, native bridge or live Y.Doc crosses this boundary. Each
// immutable SQLite capture is rendered and hashed in full before native atomic
// publication. The worker lives as long as its project's projection and keeps
// the prose it hydrated, so a capture only carries documents that changed.
const prose = new ProseJsonCache();

self.onmessage = async ({ data }: MessageEvent<{ source: LocalRelationalMarkdownSource; capturedAt: string }>) => {
  try {
    const result = await buildReadableMarkdownProjection(data.source, new Date(data.capturedAt), { hydrate: hydrateInline, proseCache: prose });
    self.postMessage({ result, proseVersions: prose.versions() });
  } catch (error) {
    prose.clear();
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
