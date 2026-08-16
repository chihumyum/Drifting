import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('external-content network boundary', () => {
  it('gates native URL metadata dispatch and both remote preview surfaces', () => {
    const platform = read('src/renderer/platform/tauri.ts');
    const dialog = read('src/renderer/features/library/LibraryDialogs.tsx');
    const card = read('src/renderer/features/library/LibraryItemCard.tsx');

    expect(platform).toContain('canUseExternalContent()');
    expect(platform).toContain("invokeContract('material_resolve_url_meta', { url })");
    expect(platform).toContain('EXTERNAL_CONTENT_OFFLINE');
    expect(dialog).toContain('!canUseExternalContent()');
    expect(dialog).toContain('urlMeta?.ogImage && canUseExternalContent()');
    expect(card).toContain("material.kind === 'url' && externalContentEnabled");
  });

  it('records external content and Agent extensions as distinct auditable purposes', () => {
    const config = read('src/renderer/lib/config.ts');
    const mcpTransport = read('src/renderer/lib/agent/runtime/mcp-transport.ts');
    const contract = read('docs/official-service.md');

    expect(config).toContain("| 'external-content'");
    expect(config).toContain("| 'agent-extension'");
    expect(mcpTransport).toContain('assertAgentExtensionNetworkAvailable()');
    expect(contract).toContain('Pasted-URL metadata and remote preview images use');
    expect(contract).toContain('per-tool grants');
  });
});
