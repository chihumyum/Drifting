import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const FORBIDDEN_HOSTED_ROUTES = [
  ['/api/ai', 'run'].join('/'),
  ['/api/ai/byok', 'test'].join('/'),
  ['/api/ai/stream', 'inline-ask'].join('/'),
];

async function source(path: string): Promise<string> {
  return readFile(join(ROOT, path), 'utf8');
}

async function sourceTree(path: string): Promise<string> {
  const absolute = join(ROOT, path);
  const entries = await readdir(absolute, { withFileTypes: true });
  const parts: string[] = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      parts.push(await sourceTree(child));
    } else if (['.ts', '.tsx'].includes(extname(entry.name)) && !entry.name.includes('.test.')) {
      parts.push(await source(child));
    }
  }
  return parts.join('\n');
}

describe('local-only AI boundary', () => {
  it('contains no retired hosted AI route in the AI substrate or Settings source', async () => {
    const runtime = [
      await sourceTree('src/renderer/lib/ai'),
      await source('src/renderer/features/settings/panels/IntelligenceSettingsPanels.tsx'),
    ].join('\n');

    for (const route of FORBIDDEN_HOSTED_ROUTES) expect(runtime).not.toContain(route);
    expect(runtime).toContain('testByokProviderConnection');
  });
});
