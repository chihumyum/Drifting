/**
 * Prose shape statistics for the stats panel: paragraph / sentence counts and
 * a dialogue ratio, computed from a serialized ProseMirror doc. Pure text
 * analysis — word counting lives in word-count.ts and is not duplicated here.
 */

export interface ProseStats {
  /** Non-empty top-level blocks. */
  paragraphs: number;
  /** Sentence-terminator runs (。！？… plus Latin .!? at a boundary). */
  sentences: number;
  /** 0..1 share of non-whitespace characters inside quotation marks. */
  dialogueRatio: number;
}

interface PmNode {
  type?: string;
  text?: string;
  content?: PmNode[];
}

// Paired quote styles treated as dialogue. CJK corner brackets, curly double
// and single quotes, and straight double quotes. Straight single quotes are
// deliberately excluded — apostrophes would corrupt the count.
const QUOTE_PATTERNS: RegExp[] = [
  /「([^」]*)」/g,
  /『([^』]*)』/g,
  /“([^”]*)”/g,
  /‘([^’]*)’/g,
  /"([^"]*)"/g,
];

// Sentence terminators: any run of CJK enders, or Latin enders followed by
// whitespace / end-of-text (so decimals like 3.14 don't split).
const SENTENCE_END = /[。！？…]+|[.!?]+(?=\s|$)/g;

function blockText(node: PmNode): string {
  if (node.type === 'text' && typeof node.text === 'string') return node.text;
  if (!Array.isArray(node.content)) return '';
  return node.content.map(blockText).join('');
}

export function computeProseStats(pmJson: string | null | undefined): ProseStats {
  const empty: ProseStats = { paragraphs: 0, sentences: 0, dialogueRatio: 0 };
  if (!pmJson) return empty;
  let doc: PmNode;
  try {
    doc = JSON.parse(pmJson) as PmNode;
  } catch {
    return empty;
  }
  const blocks = (doc.content ?? [])
    .map((b) => blockText(b).trim())
    .filter((t) => t.length > 0);
  if (blocks.length === 0) return empty;

  const fullText = blocks.join('\n');

  let sentences = 0;
  for (const t of blocks) {
    const ends = t.match(SENTENCE_END)?.length ?? 0;
    // A block with prose but no terminal punctuation still reads as (at
    // least) one sentence.
    sentences += Math.max(1, ends);
  }

  let quotedChars = 0;
  for (const pattern of QUOTE_PATTERNS) {
    for (const match of fullText.matchAll(pattern)) {
      quotedChars += (match[1] ?? '').replace(/\s/g, '').length;
    }
  }
  const totalChars = fullText.replace(/\s/g, '').length;

  return {
    paragraphs: blocks.length,
    sentences,
    dialogueRatio: totalChars > 0 ? Math.min(1, quotedChars / totalChars) : 0,
  };
}
