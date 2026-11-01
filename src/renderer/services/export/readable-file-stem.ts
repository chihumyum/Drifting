const byteLength = (value: string) => new TextEncoder().encode(value).length;

/**
 * Filenames are readable on macOS/Windows and safe as Markdown destinations.
 * The project folder takes its book's name the same way.
 */
export function readableFileStem(value: string): string {
  const normalized = value.normalize('NFKC').replace(/[<>:"/\\|?*#^%\x5b\x5d\p{Cc}\p{Cf}]/gu, '-')
    .replace(/\.{2,}/gu, '-').replace(/-{2,}/gu, '-').replace(/\s+/gu, ' ').replace(/^[.\s]+|[.\s]+$/gu, '');
  let result = '';
  for (const char of normalized || '未命名') { if (byteLength(result + char) > 120) break; result += char; }
  result = result.replace(/[. ]+$/gu, '') || '未命名';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(result)) result = `_${result}`;
  return result;
}
