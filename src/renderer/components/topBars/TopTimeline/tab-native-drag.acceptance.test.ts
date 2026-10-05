import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('desktop HTML tab drag ownership', () => {
  it.each(['tauri.conf.json', 'tauri.macos.conf.json'])(
    '%s leaves native drop delivery to the webview', file => {
      const config = JSON.parse(readFileSync(resolve('src-tauri', file), 'utf8'));
      const main = config.app.windows.find((window: { label: string }) => window.label === 'main');
      // macOS replaces the base windows array; both must disable the native
      // file-drop handler or Wry consumes Enter/Over/Drop before HTML sees them.
      expect(main.dragDropEnabled).toBe(false);
      expect(main.titleBarStyle).toBe('Overlay');
    },
  );
});
