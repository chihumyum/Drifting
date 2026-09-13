import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { deferredAIProvidersPlugins } from '../../../vite-plugins/deferred-ai-providers';

type Transform = (this: { error(message: string): never }, code: string, id: string, options?: { ssr?: boolean }) => { code: string } | undefined;
function fixture() {
  const root = process.cwd(); const file = path.join(root, 'src/renderer/lib/ai/client/providers/provider-code.ts');
  const code = readFileSync(file, 'utf8');
  const plugin = deferredAIProvidersPlugins().find(plugin => plugin.name === 'drifting-provider-code-imports')!;
  (plugin.configResolved as (config: { root: string }) => void)({ root });
  const transform = (source: string, id: string, ssr = false) => (plugin.transform as Transform).call({ error(message) { throw new Error(message); } }, source, id, { ssr });
  return { transform, file, code };
}
it('keeps ordinary imports in SSR and leaves unrelated modules alone', () => {
  const f = fixture(); expect(f.transform(f.code, f.file, true)).toBeUndefined(); expect(f.transform(f.code, `${f.file}.unrelated`)).toBeUndefined();
});
it('rewrites both browser loaders to the same-build retry entries', () => {
  const f = fixture(); const transformed = f.transform(f.code, f.file)!.code;
  expect(transformed).toContain("from 'virtual:openai-providers'"); expect(transformed).toContain("from 'virtual:google-provider'");
  expect(transformed).toContain('shareCode(loadOpenAICode)'); expect(transformed).toContain('shareCode(loadGoogleCode)');
  expect(transformed).not.toContain("import('./openai-compatible-runtime')"); expect(transformed).not.toContain("import('./google-runtime')");
});
it('fails the build if a required import changes instead of silently losing retry support', () => {
  const f = fixture(); expect(() => f.transform(f.code.replace("import('./google-runtime')", "import('./missing-runtime')"), f.file)).toThrow('Missing deferred provider import: google-runtime');
});
