import { Marked, type TokenizerExtension } from 'marked';

/**
 * The Agent's answers and working memory as HTML: GitHub Markdown, line breaks
 * kept, raw HTML escaped first so model output cannot inject tags.
 *
 * CommonMark closes `**` only when it is not preceded by punctuation or is
 * followed by space or punctuation. Chinese puts a full-width mark before the
 * closing stars and a character right after them — 「**出处：**明·方汝浩」 —
 * so the strict rule leaves the stars on screen. Here `**…**` on one line is
 * bold whenever it has text inside, as the editor's typing rules already
 * treat it (`lib/extensions/inline-markdown-rules.ts`).
 */
const cjkStrong: TokenizerExtension = {
  name: 'cjkStrong',
  level: 'inline',
  start(source) {
    const index = source.indexOf('**');
    return index < 0 ? undefined : index;
  },
  tokenizer(source) {
    const match = /^\*\*(?![\s*])([^\n]*?[^\s*\\])\*\*(?!\*)/.exec(source);
    if (!match) return undefined;
    return { type: 'strong', raw: match[0], text: match[1], tokens: this.lexer.inlineTokens(match[1]) };
  },
};

const agentMarked = new Marked({ breaks: true, gfm: true, async: false, extensions: [cjkStrong] });

export function escapeAgentHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

/**
 * The Agent cites passages as `[…](drifting:chapters/第七章 革命/prose.md#L11-L13)`
 * (system prompt), naming a chapter by its title. A title with a space makes
 * the destination invalid Markdown and the whole link stays on screen as
 * text; its spaces are encoded so it parses, and `parseLocationHref` decodes
 * them again.
 */
function encodeLocationDestinations(markdown: string): string {
  return markdown.replace(/\]\((drifting:[^()\n]*?)\)/g, (link, destination: string) =>
    destination.includes(' ') ? `](${destination.replace(/ /g, '%20')})` : link);
}

/** Markdown the caller has already escaped (escapeAgentHtml), as HTML. */
export function renderEscapedAgentMarkdown(escaped: string): string {
  return agentMarked.parse(encodeLocationDestinations(escaped)) as string;
}

export function renderAgentMarkdown(text: string): string {
  return renderEscapedAgentMarkdown(escapeAgentHtml(text));
}
