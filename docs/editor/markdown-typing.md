# Markdown as you type

The chapter and idea editor turns Markdown into formatting as it is typed or
pasted, so a writer never has to leave the keyboard. Notes (the `note` editor
profile used by material notes) add lists, task lists, tables and code.

| Typed | Becomes | Where |
| --- | --- | --- |
| `# ` / `## ` / `### ` at the start of a paragraph | H1 / H2 / H3 | everywhere |
| `> ` at the start of a paragraph | block quote | everywhere |
| `---` on an empty line | separator (horizontal rule) | everywhere |
| `**bold**`, `__bold__` | bold | everywhere |
| `*italic*`, `_italic_` | italic | everywhere |
| `~~struck~~` | strikethrough | everywhere |
| `- `, `1. `, `[ ] ` at the start of a paragraph | list, numbered list, task | notes only |
| `` `code` ``, ```` ``` ```` | inline code, code block | notes only |

Chapters and ideas have no lists or code on purpose: disabling those nodes and
marks also removes their input rules and shortcuts
(`src/renderer/lib/editor-schema-profile.ts`).

## Inline marks inside Chinese prose

StarterKit's rules open a mark only at the start of a block or after a space,
which English puts between words and Chinese never does, so
`他把**吸铁石**拍在桌上` and `“**吸铁石。**”` used to stay literal.
`InlineMarkdownRules` (`src/renderer/lib/extensions/inline-markdown-rules.ts`)
adds input and paste rules for a marker right after a character:

- `**` and `~~` may follow any character but a space or the marker itself, as
  in Markdown;
- a single `*` or `_`, and `__`, need a character that is not an ASCII letter,
  digit or underscore before them, so `snake_case`, `a*b*c` and English words
  stay literal;
- the marked text may not start or end with a space (CommonMark's flanking
  rule), and a pair of double markers is never read as a single one.

The two rule sets never both fire: StarterKit's handles a marker after a space
or at the start, these handle the rest. `inline-markdown-rules.test.ts` covers
what each rule matches.

## The Agent's answers

The Agent panel renders answers and working memory with `marked`, whose strict
CommonMark rule has the same blind spot: a closing `**` right after full-width
punctuation and right before a character (`**出处：**明·方汝浩`) is not read as
the end of bold. `src/renderer/features/agent/agent-markdown.ts` gives the
panel its own `Marked` instance with one inline extension that takes `**…**`
on one line as bold when it has text inside, without touching the shared
instance the import and export code uses; `agent-markdown.test.ts` covers it.
