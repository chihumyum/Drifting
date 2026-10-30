import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');

// Tiptap adds its base sheet when an editor is created and removes it with
// the last one; each change restyles and relays out the whole document.
describe('Tiptap base styles load once with the app', () => {
  it('copies the installed Tiptap base sheet exactly', () => {
    const require = createRequire(import.meta.url);
    const dist = readFileSync(require.resolve('@tiptap/core'), 'utf8');
    const match = /const style = `([\s\S]*?)`;/.exec(dist);
    expect(match, 'Tiptap no longer ships its base sheet this way').not.toBeNull();
    const ours = source('src/styles/tiptap-base.css');
    expect(ours.slice(ours.indexOf('*/') + 3).trim()).toBe(match![1].trim());
  });

  it('creates every app editor without injecting it, and loads it at boot', () => {
    for (const file of ['src/renderer/hooks/useEntityEditor.ts', 'src/renderer/components/editor/ElementTemplateEditor.tsx']) {
      expect(source(file), file).toContain('injectCSS: false,');
    }
    expect(source('src/renderer/main.tsx')).toContain("import '../styles/tiptap-base.css';");
  });
});
