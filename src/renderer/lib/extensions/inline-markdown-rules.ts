import { Extension, markInputRule, markPasteRule } from '@tiptap/core';

// `**bold**`, `*italic*`, `~~strike~~` (and `__bold__`, `_italic_`) as typed
// or pasted inside Chinese and Japanese prose.
//
// StarterKit's own rules only open a mark at the start of a block or after a
// space (`(?:^|\s)`), which English separates words with and CJK prose never
// has: `他把**吸铁石**拍在桌上` and `“**吸铁石。**”` stayed literal. These
// rules cover exactly the other case, a marker right after a character, so
// the two sets never both fire: the lookbehind keeps the preceding character
// out of the match, and markInputRule / markPasteRule then remove only the
// markers. Like CommonMark's flanking rules, the marked text may not start or
// end with a space. A single `*` or `_` (and `__`) still needs a non-word
// character before it, so `snake_case`, `a*b*c` and English words stay
// literal; `**` and `~~` may follow anything, as in Markdown.

/** The text inside a pair of `marker`s, which may not contain the marker's character. */
function inside(marker: string): string {
  const character = marker[0] === '*' ? '\\*' : marker[0];
  const escaped = marker.split('').map((c) => (c === '*' ? '\\*' : c)).join('');
  return `${escaped}(?!\\s)([^${character}]*[^\\s${character}])${escaped}`;
}

/** What may come right before an opening marker for this rule (never a space or the marker itself). */
function before(marker: string): string {
  const character = marker[0] === '*' ? '\\*' : marker[0];
  return marker === '**' || marker === '~~' ? `[^\\s${character}]` : `[^\\s\\w${character}]`;
}

/** Typed: the closing marker was just typed, so the pair ends the text before the caret. */
export function inlineMarkdownInputPattern(marker: '**' | '__' | '*' | '_' | '~~'): RegExp {
  return new RegExp(`(?<=${before(marker)})(${inside(marker)})$`);
}

/** Pasted: every pair in the pasted text that follows a character. */
export function inlineMarkdownPastePattern(marker: '**' | '__' | '*' | '_' | '~~'): RegExp {
  // Not followed by the marker's character, so `**x**` is never read as `*` + `*x*` + `*`.
  const character = marker[0] === '*' ? '\\*' : marker[0];
  return new RegExp(`(?<=${before(marker)})(${inside(marker)})(?!${character})`, 'g');
}

const MARKS = [
  { mark: 'bold', markers: ['**', '__'] },
  { mark: 'italic', markers: ['*', '_'] },
  { mark: 'strike', markers: ['~~'] },
] as const;

export const InlineMarkdownRules = Extension.create({
  name: 'inlineMarkdownRules',

  addInputRules() {
    return MARKS.flatMap(({ mark, markers }) => {
      const type = this.editor.schema.marks[mark];
      return type ? markers.map((marker) => markInputRule({ find: inlineMarkdownInputPattern(marker), type })) : [];
    });
  },

  addPasteRules() {
    return MARKS.flatMap(({ mark, markers }) => {
      const type = this.editor.schema.marks[mark];
      return type ? markers.map((marker) => markPasteRule({ find: inlineMarkdownPastePattern(marker), type })) : [];
    });
  },
});
