import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../../..');
const source = (relative: string) => readFileSync(path.join(root, relative), 'utf8');

describe('frontend debug build and business boundaries', () => {
  it('loads the renderer bridge only behind DEV and explicit opt-in', () => {
    const main = source('src/renderer/main.tsx');
    expect(main).toContain(
      "import.meta.env.DEV && import.meta.env.VITE_DRIFTING_FRONTEND_DEBUG === '1'",
    );
    expect(main).toContain("import('./lib/frontend-debug/bridge')");
  });

  it('keeps frontend debug outside SQLite, Yjs, and product use cases', () => {
    const client = source('src/dev-cli/frontend-debug/client.ts');
    const daemon = source('src/dev-cli/frontend-debug/daemon.ts');
    const renderer = source('src/renderer/lib/frontend-debug/bridge.ts');
    for (const implementation of [client, daemon, renderer]) {
      expect(implementation).not.toMatch(
        /initDatabase|OfflineProductDatabase|writeChapterProse|Y\.Doc|metadataJson/u,
      );
    }
  });

  it('advertises capability differences instead of claiming native input parity', () => {
    const protocol = source('src/dev-cli/frontend-debug/types.ts');
    expect(protocol).toContain("inputPath: 'cdp-webview'");
    expect(protocol).toContain("inputPath: 'synthetic-dom'");
    expect(protocol).toContain('nativeInput: false');
    expect(protocol).toContain("network: 'resource-summary'");
  });

  it('does not include active-element text in an untargeted snapshot', () => {
    const executor = source('src/renderer/lib/frontend-debug/executor.ts');
    const cdpExpression = source('src/dev-cli/frontend-debug/dom-expression.ts');
    expect(executor).toContain('describe(document.activeElement, false)');
    expect(cdpExpression).toContain('describe(document.activeElement, false)');
  });
});
