import { marked, type Token, type Tokens } from 'marked';

export type AgentMarkdownHeadingLevel = 1 | 2 | 3;

export interface AgentMarkdownMarks {
  bold?: true;
  italic?: true;
  strike?: true;
  underline?: true;
  link?: string;
}

export type AgentMarkdownInline =
  | {
      kind: 'text';
      text: string;
      marks?: AgentMarkdownMarks;
    }
  | { kind: 'hardBreak' };

export type AgentMarkdownBlock =
  | {
      type: 'paragraph';
      inline: AgentMarkdownInline[];
    }
  | {
      type: 'heading';
      level: AgentMarkdownHeadingLevel;
      inline: AgentMarkdownInline[];
    }
  | {
      type: 'blockquote';
      inline: AgentMarkdownInline[];
    }
  | {
      type: 'horizontalRule';
      inline: [];
    };

const ALLOWED_LINK_PROTOCOLS = new Set(['http', 'https', 'mailto', 'tel']);

/**
 * Parse the Agent-facing Markdown file into exactly the prose surface that the
 * live TipTap editor accepts. Unsupported presentation is unwrapped into
 * ordinary paragraphs; readable text is retained, but unsupported nodes and
 * marks can never cross this boundary into Yjs.
 */
export function parseAgentProseMarkdown(markdown: string): AgentMarkdownBlock[] {
  const normalized = markdown.replace(/\r\n?/g, '\n');
  if (normalized.length === 0) return [paragraph([])];
  const tokens = marked.lexer(normalized, { gfm: true, breaks: false });
  const blocks = blockTokensToAgentBlocks(tokens);
  return blocks.length > 0 ? blocks : [paragraph([])];
}

/** Render one schema-safe block back to the Agent's compact Markdown view. */
export function renderAgentProseMarkdownBlock(block: AgentMarkdownBlock): string {
  if (block.type === 'horizontalRule') return '---';
  const inline = renderAgentMarkdownInline(block.inline);
  switch (block.type) {
    case 'heading':
      return `${'#'.repeat(block.level)} ${inline}`;
    case 'blockquote':
      return `> ${inline}`;
    case 'paragraph':
      return protectParagraphBlockPrefix(inline);
  }
}

export function agentMarkdownInlineText(inline: readonly AgentMarkdownInline[]): string {
  return inline.map((node) => (node.kind === 'hardBreak' ? '\n' : node.text)).join('');
}

export function normalizeAgentMarkdownLink(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const href = value.trim();
  if (
    !href ||
    [...href].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    return null;
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(href)?.[1]?.toLowerCase();
  if (scheme && !ALLOWED_LINK_PROTOCOLS.has(scheme)) return null;
  return href;
}

function blockTokensToAgentBlocks(tokens: readonly Token[]): AgentMarkdownBlock[] {
  const blocks: AgentMarkdownBlock[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'space':
      case 'def':
        break;
      case 'heading': {
        const heading = token as Tokens.Heading;
        const inline = inlineTokensToAgentInline(heading.tokens);
        if (heading.depth >= 1 && heading.depth <= 3) {
          blocks.push({
            type: 'heading',
            level: heading.depth as AgentMarkdownHeadingLevel,
            inline,
          });
        } else {
          blocks.push(paragraph(inline));
        }
        break;
      }
      case 'paragraph': {
        const tokenWithInline = token as Tokens.Paragraph;
        blocks.push(paragraph(inlineTokensToAgentInline(tokenWithInline.tokens)));
        break;
      }
      case 'text': {
        const text = token as Tokens.Text;
        blocks.push(
          paragraph(
            text.tokens
              ? inlineTokensToAgentInline(text.tokens)
              : textToInline(decodeHtmlEntities(text.text)),
          ),
        );
        break;
      }
      case 'blockquote': {
        const quote = token as Tokens.Blockquote;
        const quoteBlocks = blockTokensToAgentBlocks(quote.tokens);
        blocks.push({ type: 'blockquote', inline: flattenBlocksToInline(quoteBlocks) });
        break;
      }
      case 'hr':
        blocks.push({ type: 'horizontalRule', inline: [] });
        break;
      case 'list':
        blocks.push(...listToPlainParagraphs(token as Tokens.List));
        break;
      case 'code':
        blocks.push(...plainTextToParagraphs((token as Tokens.Code).text));
        break;
      case 'table':
        blocks.push(...tableToPlainParagraphs(token as Tokens.Table));
        break;
      case 'html':
        blocks.push(...plainTextToParagraphs(readableHtmlText((token as Tokens.HTML).text)));
        break;
      default:
        blocks.push(...unknownTokenToPlainParagraphs(token));
        break;
    }
  }
  return blocks;
}

function listToPlainParagraphs(list: Tokens.List): AgentMarkdownBlock[] {
  const blocks: AgentMarkdownBlock[] = [];
  for (const item of list.items) {
    const itemBlocks = blockTokensToAgentBlocks(item.tokens);
    if (itemBlocks.length === 0) {
      blocks.push(...plainTextToParagraphs(item.text));
      continue;
    }
    for (const block of itemBlocks) {
      if (block.type === 'horizontalRule') continue;
      blocks.push(paragraph(block.inline));
    }
  }
  return blocks;
}

function tableToPlainParagraphs(table: Tokens.Table): AgentMarkdownBlock[] {
  return [table.header, ...table.rows].map((row) =>
    paragraph(
      row.flatMap((cell, index) => [
        ...(index > 0 ? textToInline(' | ') : []),
        ...inlineTokensToAgentInline(cell.tokens),
      ]),
    ),
  );
}

function unknownTokenToPlainParagraphs(token: Token): AgentMarkdownBlock[] {
  const generic = token as Token & { tokens?: Token[]; text?: unknown; raw?: unknown };
  if (Array.isArray(generic.tokens)) {
    const blocks = blockTokensToAgentBlocks(generic.tokens);
    if (blocks.length > 0) {
      return blocks.map((block) =>
        block.type === 'horizontalRule' ? paragraph([]) : paragraph(block.inline),
      );
    }
  }
  const value =
    typeof generic.text === 'string'
      ? generic.text
      : typeof generic.raw === 'string'
        ? generic.raw
        : '';
  return plainTextToParagraphs(readableHtmlText(value));
}

function inlineTokensToAgentInline(
  tokens: readonly Token[],
  inherited: AgentMarkdownMarks = {},
): AgentMarkdownInline[] {
  const inline: AgentMarkdownInline[] = [];
  let underlineDepth = inherited.underline ? 1 : 0;

  for (const token of tokens) {
    const marks = (): AgentMarkdownMarks => ({
      ...inherited,
      ...(underlineDepth > 0 ? { underline: true } : {}),
    });
    switch (token.type) {
      case 'strong':
        inline.push(
          ...inlineTokensToAgentInline((token as Tokens.Strong).tokens, {
            ...marks(),
            bold: true,
          }),
        );
        break;
      case 'em':
        inline.push(
          ...inlineTokensToAgentInline((token as Tokens.Em).tokens, {
            ...marks(),
            italic: true,
          }),
        );
        break;
      case 'del':
        inline.push(
          ...inlineTokensToAgentInline((token as Tokens.Del).tokens, {
            ...marks(),
            strike: true,
          }),
        );
        break;
      case 'link': {
        const link = token as Tokens.Link;
        const href = normalizeAgentMarkdownLink(link.href);
        inline.push(
          ...inlineTokensToAgentInline(link.tokens, {
            ...marks(),
            ...(href ? { link: href } : {}),
          }),
        );
        break;
      }
      case 'image': {
        const image = token as Tokens.Image;
        inline.push(...markedTextNode(image.text, marks()));
        break;
      }
      case 'codespan':
        inline.push(...markedTextNode((token as Tokens.Codespan).text, marks()));
        break;
      case 'br':
        inline.push({ kind: 'hardBreak' });
        break;
      case 'html': {
        const html = (token as Tokens.Tag | Tokens.HTML).text.trim();
        if (/^<u(?:\s[^>]*)?>$/iu.test(html)) underlineDepth += 1;
        else if (/^<\/u\s*>$/iu.test(html)) underlineDepth = Math.max(0, underlineDepth - 1);
        else if (/^<br\s*\/?\s*>$/iu.test(html)) inline.push({ kind: 'hardBreak' });
        else {
          const readable = readableHtmlText(html);
          if (readable) inline.push(...markedTextNode(readable, marks()));
        }
        break;
      }
      case 'text': {
        const text = token as Tokens.Text;
        inline.push(
          ...(text.tokens
            ? inlineTokensToAgentInline(text.tokens, marks())
            : markedTextNode(text.text, marks())),
        );
        break;
      }
      case 'escape':
        inline.push(...markedTextNode((token as Tokens.Escape).text, marks()));
        break;
      default: {
        const record = token as Token & { text?: unknown; raw?: unknown };
        const value =
          typeof record.text === 'string'
            ? record.text
            : typeof record.raw === 'string'
              ? readableHtmlText(record.raw)
              : '';
        inline.push(...markedTextNode(value, marks()));
        break;
      }
    }
  }
  return mergeAgentMarkdownInline(inline);
}

function markedTextNode(text: string, marks: AgentMarkdownMarks): AgentMarkdownInline[] {
  return textToInline(decodeHtmlEntities(text), marks);
}

function textToInline(text: string, marks: AgentMarkdownMarks = {}): AgentMarkdownInline[] {
  if (!text) return [];
  return [
    {
      kind: 'text',
      text,
      ...(Object.keys(marks).length > 0 ? { marks } : {}),
    },
  ];
}

function paragraph(inline: AgentMarkdownInline[]): AgentMarkdownBlock {
  return { type: 'paragraph', inline: mergeAgentMarkdownInline(inline) };
}

function flattenBlocksToInline(blocks: readonly AgentMarkdownBlock[]): AgentMarkdownInline[] {
  return mergeAgentMarkdownInline(
    blocks.flatMap((block, index) => [
      ...(index > 0 ? ([{ kind: 'hardBreak' }, { kind: 'hardBreak' }] as const) : []),
      ...(block.type === 'horizontalRule' ? textToInline('---') : block.inline),
    ]),
  );
}

function plainTextToParagraphs(value: string): AgentMarkdownBlock[] {
  const normalized = decodeHtmlEntities(value.replace(/\r\n?/g, '\n'));
  const chunks = normalized.split(/\n{2,}/u);
  return chunks.map((chunk) => {
    const lines = chunk.split('\n');
    return paragraph(
      lines.flatMap((line, index) => [
        ...(index > 0 ? ([{ kind: 'hardBreak' }] as const) : []),
        ...textToInline(line),
      ]),
    );
  });
}

function renderAgentMarkdownInline(inline: readonly AgentMarkdownInline[]): string {
  return mergeAgentMarkdownInline(inline)
    .map((node) => {
      if (node.kind === 'hardBreak') return '<br>';
      let value = node.text.split(/\r?\n/gu).map(escapeMarkdownText).join('<br>');
      const marks = node.marks ?? {};
      if (marks.bold) value = `**${value}**`;
      if (marks.italic) value = `*${value}*`;
      if (marks.strike) value = `~~${value}~~`;
      if (marks.underline) value = `<u>${value}</u>`;
      const href = normalizeAgentMarkdownLink(marks.link);
      if (href) value = `[${value}](${escapeLinkDestination(href)})`;
      return value;
    })
    .join('');
}

function mergeAgentMarkdownInline(
  inline: readonly AgentMarkdownInline[],
): AgentMarkdownInline[] {
  const merged: AgentMarkdownInline[] = [];
  for (const node of inline) {
    if (node.kind === 'text' && !node.text) continue;
    const previous = merged[merged.length - 1];
    if (
      node.kind === 'text' &&
      previous?.kind === 'text' &&
      marksKey(previous.marks) === marksKey(node.marks)
    ) {
      merged[merged.length - 1] = { ...previous, text: previous.text + node.text };
    } else {
      merged.push(node);
    }
  }
  return merged;
}

function marksKey(marks: AgentMarkdownMarks | undefined): string {
  if (!marks) return '';
  return [
    marks.bold ? 'b' : '',
    marks.italic ? 'i' : '',
    marks.strike ? 's' : '',
    marks.underline ? 'u' : '',
    marks.link ? `l:${marks.link}` : '',
  ].join('|');
}

function escapeMarkdownText(value: string): string {
  return value.replace(/[\\`*_[\]~<|]/gu, '\\$&');
}

function escapeLinkDestination(value: string): string {
  return value
    .replace(/\\/gu, '%5C')
    .replace(/\s/gu, (char) => encodeURIComponent(char))
    .replace(/\(/gu, '%28')
    .replace(/\)/gu, '%29');
}

function protectParagraphBlockPrefix(value: string): string {
  if (/^\s{0,3}#{1,6}(?:\s|$)/u.test(value)) return value.replace('#', '\\#');
  if (/^\s{0,3}>/u.test(value)) return value.replace('>', '\\>');
  if (/^\s{0,3}[-+*](?:\s|$)/u.test(value)) {
    return value.replace(/[-+*]/u, (marker) => `\\${marker}`);
  }
  if (/^\s{0,3}\d+[.)](?:\s|$)/u.test(value)) {
    return value.replace(/([.)])(?=\s|$)/u, '\\$1');
  }
  if (/^\s{0,3}(?:`{3,}|~{3,})/u.test(value)) return `\\${value}`;
  if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(value)) {
    return value.replace(/[-*_]/u, (marker) => `\\${marker}`);
  }
  return value;
}

function readableHtmlText(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<br\s*\/?\s*>/giu, '\n')
      .replace(/<\/(?:address|article|aside|blockquote|div|h[1-6]|header|li|main|p|section)>/giu, '\n')
      .replace(/<[^>]*>/gu, ''),
  ).trim();
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: '\u00a0',
    quot: '"',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (match, entity: string) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? match;
    const radix = entity[1]?.toLowerCase() === 'x' ? 16 : 10;
    const digits = radix === 16 ? entity.slice(2) : entity.slice(1);
    const codePoint = Number.parseInt(digits, radix);
    if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return match;
    }
  });
}
