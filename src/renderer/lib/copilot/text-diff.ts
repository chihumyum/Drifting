/**
 * Tiny dependency-free character-level diff, sized for prose blocks (a
 * paragraph or two, not whole documents). Used by the inline-edit diff panel
 * to show what changed inside a block — original struck red, revised green —
 * the way a coding agent shows a hunk.
 *
 * Algorithm: trim the common prefix/suffix (most edits are localized, so this
 * collapses the problem to the changed middle in O(n)), then run a classic
 * LCS over the remaining middle. CJK has no word boundaries, so we diff by
 * character (code point), which reads cleanly for Chinese prose.
 */

export type DiffChunkType = 'equal' | 'insert' | 'delete';

export interface DiffChunk {
  type: DiffChunkType;
  text: string;
}

/** Split into Unicode code points so surrogate pairs (emoji, rare CJK) stay whole. */
function toChars(s: string): string[] {
  return Array.from(s);
}

/**
 * Character-level diff of `oldText` → `newText`. Returns ordered chunks;
 * adjacent chunks of the same type are merged. Equal runs appear as `equal`,
 * removed runs as `delete`, added runs as `insert`.
 */
export function diffChars(oldText: string, newText: string): DiffChunk[] {
  if (oldText === newText) {
    return oldText ? [{ type: 'equal', text: oldText }] : [];
  }

  const a = toChars(oldText);
  const b = toChars(newText);

  // Common prefix.
  let start = 0;
  const minLen = Math.min(a.length, b.length);
  while (start < minLen && a[start] === b[start]) start++;

  // Common suffix (not overlapping the prefix).
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  const chunks: DiffChunk[] = [];
  const push = (type: DiffChunkType, text: string) => {
    if (!text) return;
    const last = chunks[chunks.length - 1];
    if (last && last.type === type) last.text += text;
    else chunks.push({ type, text });
  };

  push('equal', a.slice(0, start).join(''));
  for (const c of lcsDiff(midA, midB)) push(c.type, c.text);
  push('equal', a.slice(endA).join(''));

  return chunks;
}

/** LCS-based diff over the already-trimmed middle segments. */
function lcsDiff(a: string[], b: string[]): DiffChunk[] {
  if (a.length === 0) return b.length ? [{ type: 'insert', text: b.join('') }] : [];
  if (b.length === 0) return [{ type: 'delete', text: a.join('') }];

  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i:] and b[j:].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const out: DiffChunk[] = [];
  const push = (type: DiffChunkType, text: string) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push('equal', a[i]!);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      push('delete', a[i]!);
      i++;
    } else {
      push('insert', b[j]!);
      j++;
    }
  }
  while (i < n) push('delete', a[i++]!);
  while (j < m) push('insert', b[j++]!);

  return out;
}
