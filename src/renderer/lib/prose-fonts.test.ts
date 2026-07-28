import { describe, expect, it } from 'vitest';
import {
  MAX_IMPORTED_PROSE_FONT_BYTES,
  ProseFontImportError,
  validateImportedProseFontFile,
} from './prose-fonts';

describe('prose font import validation', () => {
  it.each(['Regular.ttf', 'Book.OTF', 'web.woff', 'variable.WOFF2'])(
    'accepts one supported font file: %s',
    (name) => {
      expect(() => validateImportedProseFontFile({ name, size: 1024 })).not.toThrow();
    },
  );

  it.each([
    [{ name: 'font.ttc', size: 1024 }, 'unsupported-format'],
    [{ name: 'font.ttf', size: 0 }, 'empty'],
    [{ name: 'font.otf', size: MAX_IMPORTED_PROSE_FONT_BYTES + 1 }, 'too-large'],
  ] as const)('rejects invalid input with a stable code', (file, code) => {
    try {
      validateImportedProseFontFile(file);
      throw new Error('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ProseFontImportError);
      expect((error as ProseFontImportError).code).toBe(code);
    }
  });
});
