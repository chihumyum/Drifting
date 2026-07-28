import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyEditorPreferences,
  editorFontFamilyValue,
  type EditorPreferences,
} from './editor-preferences';

const BASE_PREFERENCES: EditorPreferences = {
  editorFontSource: 'system-serif',
  editorSystemFontFamily: '',
  bodyFontSize: 17,
  lineHeight: 1.5,
  maxLineWidth: 720,
  paragraphIndent: 'none',
  editorIndentStep: 2,
  paragraphSpacing: 1,
  focusLine: 'off',
  entityLinkInteractive: true,
};

describe('editor preferences', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['system-serif', '', 'var(--font-prose-system-serif)'],
    ['system-sans', '', 'var(--font-prose-system-sans)'],
    ['system-custom', 'Charter', '"Charter", var(--font-prose-system-serif)'],
    ['imported', '', '"Drifting Imported Prose", var(--font-prose-system-serif)'],
  ] as const)(
    'maps %s to the editor-only font stack',
    (editorFontSource, editorSystemFontFamily, expected) => {
      const setProperty = vi.fn();
      const setAttribute = vi.fn();
      vi.stubGlobal('document', {
        documentElement: { style: { setProperty }, setAttribute },
      });

      applyEditorPreferences({
        ...BASE_PREFERENCES,
        editorFontSource,
        editorSystemFontFamily,
      });

      expect(setProperty).toHaveBeenCalledWith('--editor-font-family', expected);
      expect(setAttribute).toHaveBeenCalledWith('data-focus-line', 'off');
      expect(setAttribute).toHaveBeenCalledWith('data-entity-link-interactive', 'on');
    },
  );

  it('quotes a custom family as one CSS family instead of accepting a font stack', () => {
    expect(editorFontFamilyValue('system-custom', 'A "Quoted", serif')).toBe(
      '"A \\"Quoted\\", serif", var(--font-prose-system-serif)',
    );
  });
});
