import path from 'node:path';
import type { Plugin } from 'vite';

/** Retry the same build's entry bytes with a fresh browser module-map key. */
export function deferredEntryPlugin(options: {
  id: string; entry: string; name: string; exportName: string; attemptParam: string;
}): Plugin {
  const resolvedId = `\0${options.id}`;
  let root = '';
  let building = false;
  return {
    name: `drifting-deferred-${options.name}`,
    configResolved(config) { root = config.root; building = config.command === 'build'; },
    resolveId(id) { if (id === options.id) return resolvedId; },
    load(id) {
      if (id !== resolvedId) return;
      const reference = building ? this.emitFile({
        type: 'chunk', id: path.resolve(root, options.entry), name: options.name, preserveSignature: 'strict',
      }) : null;
      const url = reference ? `import.meta.ROLLUP_FILE_URL_${reference}`
        : `new URL(${JSON.stringify(`/${options.entry}`)}, import.meta.url).href`;
      return `
        let attempt = 0;
        export function ${options.exportName}() {
          const url = new URL(${url});
          url.searchParams.set(${JSON.stringify(options.attemptParam)}, String(++attempt));
          return import(/* @vite-ignore */ url.href);
        }
      `;
    },
  };
}
