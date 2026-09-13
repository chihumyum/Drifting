import { normalizePath, type Plugin } from 'vite';
import { deferredEntryPlugin } from './deferred-entry';

const entries = [
  { name: 'openai-providers', file: 'openai-compatible-runtime', exported: 'loadOpenAICode' },
  { name: 'google-provider', file: 'google-runtime', exported: 'loadGoogleCode' },
] as const;

/** Keep ordinary imports for Node/SSR; browser retries get fresh module-map keys. */
export function deferredAIProvidersPlugins(): Plugin[] {
  let root = '';
  return [
    ...entries.map(({ name, file, exported }) => deferredEntryPlugin({
      id: `virtual:${name}`, entry: `src/renderer/lib/ai/client/providers/${file}.ts`,
      name, exportName: exported, attemptParam: 'provider-attempt',
    })),
    {
      name: 'drifting-provider-code-imports', enforce: 'pre',
      configResolved(config) { root = normalizePath(config.root); },
      transform(code, id, options) {
        if (options?.ssr || normalizePath(id) !== `${root}/src/renderer/lib/ai/client/providers/provider-code.ts`) return;
        for (const { name, file, exported } of entries) {
          const original = `() => import('./${file}')`;
          if (!code.includes(original)) this.error(`Missing deferred provider import: ${file}`);
          code = `import { ${exported} } from 'virtual:${name}';\n` + code.replace(original, exported);
        }
        return { code, map: null };
      },
    },
  ];
}
