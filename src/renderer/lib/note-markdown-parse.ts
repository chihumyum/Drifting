import type { JSONContent } from '@tiptap/core';
import { marked, type Token, type Tokens } from 'marked';

import type { EntityLocationAttrs } from './location-link';
import { schemaForProfile } from './editor-schema-profile';

/**
 * Markdown → material-note blocks (`note` profile), the inverse of
 * note-markdown.ts. The Agent writes notes in this dialect: GFM tables and
 * task lists, nested lists, code fences, `> [!note]` callouts, `==`
 * highlights, `［素材：标题］` embeds and drifting: location links. Anything the
 * note schema cannot hold is unwrapped into readable paragraphs.
 */
export interface NoteMarkdownParseOptions {
  /** A fresh id for every node the block-id extension identifies. */
  nextId: () => string;
  /** The material an embed line names, or null to keep the line as text. */
  embedId?: (title: string) => string | null;
  /** entityLink attributes for a drifting: location href, or null. */
  location?: (href: string) => EntityLocationAttrs | null;
}

/** An embed line as note-markdown renders it for the Agent. */
export const NOTE_EMBED_LINE = /^［素材(?:[：:]\s*(.+?))?\s*］$/u;

const ALLOWED_LINK_PROTOCOLS = new Set(['http', 'https', 'mailto', 'tel']);

type Mark = NonNullable<JSONContent['marks']>[number];

/** Top-level note nodes for `markdown`; never empty (an empty note is one paragraph). */
export function parseNoteMarkdown(markdown: string, options: NoteMarkdownParseOptions): JSONContent[] {
  const normalized = markdown.replace(/\r\n?/gu, '\n');
  const parser = new NoteParser(options);
  const nodes = normalized.trim() ? parser.blocks(marked.lexer(normalized, { gfm: true, breaks: false })) : [];
  const content = nodes.length > 0 ? nodes : [parser.paragraph([])];
  // Fail before anything reaches Yjs if the result is not a valid note.
  schemaForProfile('note').nodeFromJSON({ type: 'doc', content }).check();
  return content;
}

class NoteParser {
  constructor(private readonly options: NoteMarkdownParseOptions) {}

  blocks(tokens: readonly Token[]): JSONContent[] {
    const result: JSONContent[] = [];
    for (const token of tokens) result.push(...this.block(token));
    return result;
  }

  paragraph(content: JSONContent[]): JSONContent {
    return { type: 'paragraph', attrs: { id: this.options.nextId() }, ...(content.length ? { content } : {}) };
  }

  private block(token: Token): JSONContent[] {
    switch (token.type) {
      case 'space':
      case 'def':
        return [];
      case 'heading': {
        const heading = token as Tokens.Heading;
        const content = this.inline(heading.tokens);
        return [{
          type: 'heading',
          attrs: { id: this.options.nextId(), level: Math.min(3, Math.max(1, heading.depth)) },
          ...(content.length ? { content } : {}),
        }];
      }
      case 'paragraph':
      case 'text': {
        const text = token as Tokens.Paragraph | Tokens.Text;
        const embed = this.embed(text.text);
        if (embed) return [embed];
        return [this.paragraph(text.tokens ? this.inline(text.tokens) : this.text(text.text, []))];
      }
      case 'blockquote':
        return [this.blockquote(token as Tokens.Blockquote)];
      case 'hr':
        return [{ type: 'horizontalRule', attrs: { id: this.options.nextId() } }];
      case 'list':
        return [this.list(token as Tokens.List)];
      case 'code': {
        const code = token as Tokens.Code;
        const language = code.lang?.trim().split(/\s+/u)[0] || null;
        return [{
          type: 'codeBlock',
          attrs: { id: this.options.nextId(), language },
          ...(code.text ? { content: [{ type: 'text', text: code.text }] } : {}),
        }];
      }
      case 'table':
        return [this.table(token as Tokens.Table)];
      case 'html': {
        const readable = readableHtmlText((token as Tokens.HTML).text);
        return readable ? [this.paragraph(this.text(readable, []))] : [];
      }
      default: {
        const raw = (token as { text?: unknown; raw?: unknown }).text ?? (token as { raw?: unknown }).raw;
        return typeof raw === 'string' && raw.trim() ? [this.paragraph(this.text(raw.trim(), []))] : [];
      }
    }
  }

  private embed(text: string): JSONContent | null {
    const match = NOTE_EMBED_LINE.exec(text.trim());
    if (!match?.[1] || !this.options.embedId) return null;
    const libraryItemId = this.options.embedId(match[1].trim());
    return libraryItemId
      ? { type: 'materialEmbed', attrs: { id: this.options.nextId(), libraryItemId } }
      : null;
  }

  /** `> [!type]` opens a callout (paragraphs only); anything else is a quote. */
  private blockquote(token: Tokens.Blockquote): JSONContent {
    const first = token.tokens[0];
    const marker = first?.type === 'paragraph' ? /^\[!\w+\][^\n]*(?:\n|$)/u.exec((first as Tokens.Paragraph).text) : null;
    if (marker) {
      const rest = (first as Tokens.Paragraph).text.slice(marker[0].length);
      const tokens = [
        ...(rest.trim() ? marked.lexer(rest, { gfm: true }) : []),
        ...token.tokens.slice(1),
      ];
      const paragraphs = this.blocks(tokens).flatMap((node) => flattenToParagraphs(node, this));
      return {
        type: 'callout',
        attrs: { id: this.options.nextId() },
        content: paragraphs.length ? paragraphs : [this.paragraph([])],
      };
    }
    const content = this.blocks(token.tokens);
    return {
      type: 'blockquote',
      attrs: { id: this.options.nextId() },
      content: content.length ? content : [this.paragraph([])],
    };
  }

  private list(token: Tokens.List): JSONContent {
    const task = token.items.some((item) => item.task);
    const type = task ? 'taskList' : token.ordered ? 'orderedList' : 'bulletList';
    const itemType = task ? 'taskItem' : 'listItem';
    const start = typeof token.start === 'number' && token.start !== 1 ? token.start : null;
    return {
      type,
      attrs: { id: this.options.nextId(), ...(type === 'orderedList' && start !== null ? { start } : {}) },
      content: token.items.map((item) => {
        const children = this.blocks(item.tokens.filter((child) => child.type !== 'checkbox'));
        // A list item's first child is its paragraph.
        if (children[0]?.type !== 'paragraph') children.unshift(this.paragraph([]));
        return {
          type: itemType,
          attrs: { id: this.options.nextId(), ...(task ? { checked: item.checked === true } : {}) },
          content: children,
        };
      }),
    };
  }

  private table(token: Tokens.Table): JSONContent {
    const cell = (type: 'tableHeader' | 'tableCell', value: Tokens.TableCell): JSONContent => ({
      type,
      content: [this.paragraph(this.inline(value.tokens))],
    });
    const header = token.header.some((value) => value.text.trim());
    const rows: JSONContent[] = [];
    rows.push({ type: 'tableRow', content: token.header.map((value) => cell(header ? 'tableHeader' : 'tableCell', value)) });
    for (const row of token.rows) {
      rows.push({ type: 'tableRow', content: row.map((value) => cell('tableCell', value)) });
    }
    // An all-blank header row is how note-markdown renders a header-less table.
    if (!header && rows.length > 1) rows.shift();
    return { type: 'table', attrs: { id: this.options.nextId() }, content: rows };
  }

  private inline(tokens: readonly Token[], marks: Mark[] = []): JSONContent[] {
    const result: JSONContent[] = [];
    for (const token of tokens) {
      switch (token.type) {
        case 'strong':
          result.push(...this.inline((token as Tokens.Strong).tokens, withMark(marks, { type: 'bold' })));
          break;
        case 'em':
          result.push(...this.inline((token as Tokens.Em).tokens, withMark(marks, { type: 'italic' })));
          break;
        case 'del':
          result.push(...this.inline((token as Tokens.Del).tokens, withMark(marks, { type: 'strike' })));
          break;
        case 'codespan':
          // The code mark excludes every other mark.
          result.push(...plainText(decodeHtmlEntities((token as Tokens.Codespan).text), [{ type: 'code' }]));
          break;
        case 'link': {
          const link = token as Tokens.Link;
          const location = this.options.location?.(link.href) ?? null;
          const href = location ? null : safeHref(link.href);
          const mark: Mark | null = location
            ? { type: 'entityLink', attrs: { ...location } }
            : href
              ? { type: 'link', attrs: { href } }
              : null;
          result.push(...this.inline(link.tokens, mark ? withMark(marks, mark) : marks));
          break;
        }
        case 'image':
          result.push(...this.text((token as Tokens.Image).text, marks));
          break;
        case 'br':
          result.push({ type: 'hardBreak' });
          break;
        case 'html': {
          const html = (token as Tokens.Tag).text.trim();
          if (/^<br\s*\/?\s*>$/iu.test(html)) result.push({ type: 'hardBreak' });
          else result.push(...this.text(readableHtmlText(html), marks));
          break;
        }
        case 'text': {
          const text = token as Tokens.Text;
          result.push(...(text.tokens ? this.inline(text.tokens, marks) : this.text(text.text, marks)));
          break;
        }
        case 'escape':
          result.push(...plainText((token as Tokens.Escape).text, marks));
          break;
        default: {
          const raw = (token as { text?: unknown }).text;
          if (typeof raw === 'string') result.push(...this.text(raw, marks));
        }
      }
    }
    return mergeAdjacentText(result);
  }

  /** Text with `==highlights==` and soft line breaks, which notes keep as breaks. */
  private text(value: string, marks: Mark[]): JSONContent[] {
    const decoded = decodeHtmlEntities(value);
    const result: JSONContent[] = [];
    const pattern = /==(?=\S)([^=\n]*?\S)==/gu;
    let index = 0;
    for (const match of decoded.matchAll(pattern)) {
      result.push(...plainText(decoded.slice(index, match.index), marks));
      result.push(...plainText(match[1]!, withMark(marks, { type: 'highlight' })));
      index = match.index + match[0].length;
    }
    result.push(...plainText(decoded.slice(index), marks));
    return result;
  }
}

function plainText(value: string, marks: Mark[]): JSONContent[] {
  const result: JSONContent[] = [];
  value.split('\n').forEach((line, index) => {
    if (index > 0) result.push({ type: 'hardBreak' });
    if (line) result.push({ type: 'text', text: line, ...(marks.length ? { marks: [...marks] } : {}) });
  });
  return result;
}

function withMark(marks: readonly Mark[], mark: Mark): Mark[] {
  if (marks.some((existing) => existing.type === 'code')) return [...marks];
  return [...marks.filter((existing) => existing.type !== mark.type), mark];
}

function mergeAdjacentText(nodes: readonly JSONContent[]): JSONContent[] {
  const result: JSONContent[] = [];
  for (const node of nodes) {
    const previous = result[result.length - 1];
    if (
      previous?.type === 'text' &&
      node.type === 'text' &&
      JSON.stringify(previous.marks ?? []) === JSON.stringify(node.marks ?? [])
    ) {
      result[result.length - 1] = { ...previous, text: `${previous.text ?? ''}${node.text ?? ''}` };
    } else {
      result.push(node);
    }
  }
  return result;
}

/** A callout holds paragraphs only; other blocks keep their readable text. */
function flattenToParagraphs(node: JSONContent, parser: NoteParser): JSONContent[] {
  if (node.type === 'paragraph') return [node];
  if (node.type === 'heading') return [parser.paragraph(node.content ?? [])];
  const children = node.content ?? [];
  if (node.type === 'codeBlock' || children.every((child) => child.type === 'text' || child.type === 'hardBreak')) {
    return [parser.paragraph(children)];
  }
  return children.flatMap((child) => flattenToParagraphs(child, parser));
}

function safeHref(value: string): string | null {
  const href = value.trim();
  if (!href || [...href].some((character) => (character.codePointAt(0) ?? 0) <= 0x1f)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(href)?.[1]?.toLowerCase();
  if (scheme && !ALLOWED_LINK_PROTOCOLS.has(scheme)) return null;
  return href;
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
  const named: Record<string, string> = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (match, entity: string) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? match;
    const radix = entity[1]?.toLowerCase() === 'x' ? 16 : 10;
    const codePoint = Number.parseInt(entity.slice(radix === 16 ? 2 : 1), radix);
    if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return match;
    }
  });
}
