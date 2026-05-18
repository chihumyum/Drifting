/**
 * Import facade — parses a File into a normalized ParsedDoc by sniffing
 * the extension. Parsers are lazy-loaded so picking md/txt doesn't pull
 * in mammoth's bundle (~250 KB), and vice versa.
 */
import { inferFormat, type ImportFormat, type ParsedDoc } from './types';

export type { ImportFormat, ImportTarget, ParsedDoc } from './types';
export { TARGET_LABEL, TARGET_DESC, inferFormat } from './types';

export async function parseFile(file: File): Promise<ParsedDoc> {
  const format = inferFormat(file.name);
  if (!format) throw new Error(`Unsupported file type: ${file.name}`);
  return parseByFormat(file, format);
}

async function parseByFormat(file: File, format: ImportFormat): Promise<ParsedDoc> {
  switch (format) {
    case 'markdown': {
      const { parseMarkdown } = await import('./markdown');
      return parseMarkdown(file);
    }
    case 'txt': {
      const { parseTxt } = await import('./markdown');
      return parseTxt(file);
    }
    case 'docx': {
      const { parseDocx } = await import('./docx');
      return parseDocx(file);
    }
    default: {
      const _exhaustive: never = format;
      throw new Error(`Unhandled format: ${_exhaustive as string}`);
    }
  }
}
