import path from 'node:path';
import type { Plugin } from 'vite';

/** Give retries a fresh module-map key while retaining the exact bundled bytes.
 * A failed dynamic import can otherwise stay rejected for the document lifetime.
 * Successful/concurrent loads are shared by the renderer's deferred module owner. */
export function deferredSettingsPlugin(): Plugin {
  const publicId = 'virtual:settings-panels';
  const resolvedId = `\0${publicId}`;
  let root = '';
  let building = false;
  return {
    name: 'drifting-deferred-settings',
    configResolved(config) { root = config.root; building = config.command === 'build'; },
    resolveId(id) { if (id === publicId) return resolvedId; },
    load(id) {
      if (id !== resolvedId) return;
      const entry = 'src/renderer/features/settings/settings-panels.ts';
      const reference = building ? this.emitFile({
        type: 'chunk', id: path.resolve(root, entry), name: 'settings-panels', preserveSignature: 'strict',
      }) : null;
      const url = reference
        ? `import.meta.ROLLUP_FILE_URL_${reference}`
        : `new URL(${JSON.stringify(`/${entry}`)}, import.meta.url).href`;
      return `
        let attempt = 0;
        export function loadSettingsPanels() {
          const url = new URL(${url});
          url.searchParams.set('settings-attempt', String(++attempt));
          return import(/* @vite-ignore */ url.href);
        }
      `;
    },
  };
}
