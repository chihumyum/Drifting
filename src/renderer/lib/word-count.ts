/**
 * Word/character counting for mixed CJK + Latin manuscripts.
 *
 * Algorithm matches Microsoft Word's "字数" field in Chinese locale:
 *   wordCount = (CJK ideograph count) + (Latin word count)
 *
 * Where:
 *   - CJK ideographs are counted individually (Han Unified + Extension A).
 *   - Latin "words" are whitespace-separated tokens containing at least one
 *     alphanumeric character; CJK ideographs and CJK punctuation are stripped
 *     first so they cannot be miscounted as Latin words.
 *
 * Why not `text.length`: that counts whitespace and punctuation, which is the
 * crude convention used by some Chinese web-novel platforms but doesn't match
 * what Word / Scrivener / serious tools report.
 */

// U+3400–4DBF (Ext A) and U+4E00–9FFF (Unified). Compatibility ideographs
// (F900–FAFF) and Plane-2 extensions are deliberately omitted; they're rare
// enough in modern Chinese prose that adding them would broaden the regex
// without changing typical counts.
const CJK_IDEOGRAPH = /[\u3400-\u4DBF\u4E00-\u9FFF]/gu;

// Everything we want to *erase* before splitting Latin words: ideographs
// themselves, plus CJK Symbols & Punctuation (U+3000–303F) and Halfwidth /
// Fullwidth Forms (U+FF00–FFEF, where 。 ， 「 」 etc. live).
const CJK_STRIPPABLE = /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uFF00-\uFFEF]/gu;

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;

  const cjkCount = trimmed.match(CJK_IDEOGRAPH)?.length ?? 0;

  const latinCount = trimmed
    .replace(CJK_STRIPPABLE, ' ')
    .split(/\s+/)
    .reduce((n, token) => (/[A-Za-z0-9]/.test(token) ? n + 1 : n), 0);

  return cjkCount + latinCount;
}

/**
 * Count words inside a serialized ProseMirror JSON document.
 * Used when we have the saved pm_json but no live editor instance
 * (e.g. outline panels listing chapters we haven't opened).
 */
export function countWordsInPmJson(pmJson: string | null | undefined): number {
  if (!pmJson) return 0;
  try {
    const doc = JSON.parse(pmJson);
    return countWords(extractText(doc));
  } catch {
    return 0;
  }
}

interface PmNode {
  type?: string;
  text?: string;
  content?: PmNode[];
}

function extractText(node: PmNode): string {
  let out = '';
  if (node.type === 'text' && typeof node.text === 'string') {
    out += node.text;
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      out += extractText(child);
      // Block boundaries — insert whitespace so adjacent block content
      // doesn't fuse into a single "word" for Latin counting.
      out += ' ';
    }
  }
  return out;
}
