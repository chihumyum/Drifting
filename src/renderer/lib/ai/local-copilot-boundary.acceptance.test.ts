import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const PROMPTS = [
  'block-section-summary',
  'chapter-summary',
  'element-candidate',
  'element-patch',
  'inline-edit-blocks',
  'inline-edit',
  'segment-merge',
] as const;
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
    } else if (!entry.name.includes('.test.') && ['.ts', '.tsx'].includes(extname(entry.name))) {
      parts.push(await source(child));
    }
  }
  return parts.join('\n');
}

describe('local-only Copilot boundary', () => {
  it('contains no retired hosted Copilot route in runtime or Settings source', async () => {
    const runtime = [
      await sourceTree('src/renderer/lib/ai'),
      await sourceTree('src/renderer/lib/copilot'),
      await source('src/renderer/features/settings/panels/IntelligenceSettingsPanels.tsx'),
    ].join('\n');

    for (const route of FORBIDDEN_HOSTED_ROUTES) expect(runtime).not.toContain(route);
    expect(runtime).toContain('testByokProviderConnection');
    expect(runtime).toContain('buildCopilotLLMClient');
  });

  it.each(PROMPTS)('%s ships a complete renderer-local PromptDef', async (name) => {
    const prompt = await source(`src/renderer/lib/ai/prompts/templates/${name}.ts`);

    expect(prompt).toContain('definePrompt({');
    expect(prompt).toContain('buildSystem:');
    expect(prompt).toContain('buildUserMessage:');
    expect(prompt).not.toContain('defineRemotePrompt');
  });
});
