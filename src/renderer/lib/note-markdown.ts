import type { JSONContent } from '@tiptap/core';
import { parseTiptapDocJson } from '../utils/tiptap-doc';

/**
 * Markdown for material notes (`note` profile): GFM tables and task lists,
 * nested lists, code fences, callouts as Obsidian `> [!note]` blocks, `==`
 * highlights and embeds as links. Book prose keeps its own narrow Agent
 * protocol (lib/agent/serialize.ts); this renderer never sees chapters.
 */
export interface NoteMarkdownOptions {
  /** Markdown for an embedded material (a link in the export's own style);
   *  null renders a placeholder. */
  embed?: (libraryItemId: string) => string | null;
  /** Markdown for a mention of `text`; null keeps the plain text. */
  entity?: (kind: string, id: string, text: string) => string | null;
  /** Like `entity`, with the mark's full attributes (block anchors included).
   *  Takes precedence over `entity`. */
  entityLink?: (attrs: Readonly<Record<string, unknown>>, text: string) => string | null;
}

const EMBED_PLACEHOLDER = '［素材］';

export function noteToMarkdown(contentJson: string | null | undefined, options: NoteMarkdownOptions = {}): string {
  if (!contentJson) return '';
  const doc = parseTiptapDocJson(contentJson);
  return blocks(doc.content ?? [], options).join('\n\n').replace(/\n{3,}/gu, '\n\n').trim();
}

/**
 * The Markdown of each top-level node, in order and including empty ones, so
 * a caller can map a passage of the joined note back to the blocks it spans.
 * Joining the non-empty entries with a blank line reproduces noteToMarkdown
 * for every note whose blocks render without blank-line runs.
 */
export function noteBlockMarkdown(nodes: readonly JSONContent[], options: NoteMarkdownOptions = {}): string[] {
  return nodes.map((node) => block(node, options).replace(/\n{3,}/gu, '\n\n').trim());
}

/** Cards are previews, including their expanded state. Bound both text and
 * structure BEFORE Markdown/HTML conversion; CSS clipping alone still lays out
 * the entire note. Full prose remains available in the material editor. */
export function noteMarkdownExcerpt(contentJson: string | null | undefined, expanded = false): string {
  if (!contentJson) return '';
  let remaining = expanded ? 2400 : 480;
  let nodes = expanded ? 96 : 32;
  let clipped = false;
  const take = (node: JSONContent, depth: number): JSONContent | null => {
    if (remaining <= 0 || nodes-- <= 0 || depth > 24) { clipped = true; return null; }
    if (node.type === 'text') {
      const text = node.text ?? '';
      const result = text.slice(0, remaining);
      remaining -= result.length;
      if (result.length < text.length) clipped = true;
      return { ...node, text: result };
    }
    const content: JSONContent[] = [];
    for (const child of node.content ?? []) {
      const value = take(child, depth + 1);
      if (!value) break;
      content.push(value);
    }
    return { ...node, content };
  };
  const doc = take(parseTiptapDocJson(contentJson), 0);
  const markdown = blocks(doc?.content ?? [], {}).join('\n\n').replace(/\n{3,}/gu, '\n\n').trim();
  return markdown + (clipped && markdown ? '\n\n…' : '');
}

function blocks(nodes: readonly JSONContent[], options: NoteMarkdownOptions): string[] {
  return nodes.map((node) => block(node, options)).filter((text) => text.length > 0);
}

function block(node: JSONContent, options: NoteMarkdownOptions): string {
  const children = node.content ?? [];
  switch (node.type) {
    case 'paragraph':
      return inline(children, options);
    case 'heading': {
      const level = Math.min(3, Math.max(1, Number(node.attrs?.level ?? 1)));
      return `${'#'.repeat(level)} ${inline(children, options)}`;
    }
    case 'blockquote':
      return prefixLines(blocks(children, options).join('\n\n'), '> ');
    case 'callout':
      return `> [!note]\n${prefixLines(blocks(children, options).join('\n\n'), '> ')}`;
    case 'bulletList':
      return list(children, options, () => '- ');
    case 'orderedList': {
      const start = Number(node.attrs?.start ?? 1);
      return list(children, options, (index) => `${start + index}. `);
    }
    case 'taskList':
      return list(children, options, (_index, item) => (item.attrs?.checked ? '- [x] ' : '- [ ] '));
    case 'codeBlock': {
      const language = typeof node.attrs?.language === 'string' ? node.attrs.language : '';
      return `\`\`\`${language}\n${plainText(node)}\n\`\`\``;
    }
    case 'horizontalRule':
      return '---';
    case 'table':
      return table(children, options);
    case 'materialEmbed': {
      const id = typeof node.attrs?.libraryItemId === 'string' ? node.attrs.libraryItemId : null;
      return (id ? options.embed?.(id) : null) ?? EMBED_PLACEHOLDER;
    }
    default:
      return blocks(children, options).join('\n\n');
  }
}

/** A list item's first block carries the marker; the rest indent under it. */
function list(
  items: readonly JSONContent[],
  options: NoteMarkdownOptions,
  marker: (index: number, item: JSONContent) => string,
): string {
  return items
    .map((item, index) => {
      const prefix = marker(index, item);
      const [first = '', ...rest] = blocks(item.content ?? [], options);
      // A task item's content column is after "- ", not after its checkbox;
      // deeper indents read as a lazy paragraph continuation, not a sub-list.
      const indent = ' '.repeat(item.type === 'taskItem' ? 2 : prefix.length);
      return [prefix + first, ...rest.map((text) => prefixLines(text, indent))].join('\n');
    })
    .join('\n');
}

function table(rows: readonly JSONContent[], options: NoteMarkdownOptions): string {
  const cells = rows.map((row) =>
    (row.content ?? []).map((cell) =>
      blocks(cell.content ?? [], options).join('<br>').replace(/\n/gu, '<br>').replace(/\|/gu, '\\|'),
    ),
  );
  if (cells.length === 0) return '';
  const width = Math.max(...cells.map((row) => row.length));
  const pad = (row: string[]) => [...row, ...Array<string>(width - row.length).fill('')];
  const hasHeader = (rows[0]?.content ?? []).every((cell) => cell.type === 'tableHeader');
  const header = hasHeader ? pad(cells[0]!) : Array<string>(width).fill('');
  const body = hasHeader ? cells.slice(1) : cells;
  const line = (row: string[]) => `| ${row.join(' | ')} |`;
  return [line(header), line(Array<string>(width).fill('---')), ...body.map((row) => line(pad(row)))].join('\n');
}

function inline(nodes: readonly JSONContent[], options: NoteMarkdownOptions): string {
  return nodes
    .map((node) => {
      if (node.type === 'hardBreak') return '  \n';
      if (node.type !== 'text') return inline(node.content ?? [], options);
      let text = node.text ?? '';
      let href: string | null = null;
      let mention: { kind: string; id: string; attrs: Record<string, unknown> } | null = null;
      for (const mark of node.marks ?? []) {
        if (mark.type === 'code') text = `\`${text}\``;
        else if (mark.type === 'bold') text = `**${text}**`;
        else if (mark.type === 'italic') text = `*${text}*`;
        else if (mark.type === 'strike') text = `~~${text}~~`;
        else if (mark.type === 'highlight') text = `==${text}==`;
        else if (mark.type === 'link' && typeof mark.attrs?.href === 'string') href = mark.attrs.href;
        else if (mark.type === 'entityLink') {
          const kind = mark.attrs?.targetKind;
          const id = mark.attrs?.targetId;
          if (typeof kind === 'string' && typeof id === 'string') mention = { kind, id, attrs: mark.attrs ?? {} };
        }
      }
      if (href) return `[${text}](${href})`;
      if (!mention) return text;
      if (options.entityLink) return options.entityLink(mention.attrs, text) ?? text;
      return options.entity?.(mention.kind, mention.id, text) ?? text;
    })
    .join('');
}

function plainText(node: JSONContent): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  return (node.content ?? []).map(plainText).join('');
}

function prefixLines(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => (line ? prefix + line : prefix.trimEnd()))
    .join('\n');
}
