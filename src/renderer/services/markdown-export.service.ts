import type { Mark as PMMark, Node as PMNode } from '@tiptap/pm/model';
import type { EntityKind } from '../sqlite-repo/reference-repo';

// Resolves the human display label for an entityLink target. Implementations
// typically pull from the live data store (bookElements / bookNodes). Falls
// back to a placeholder when the target was deleted.
export type EntityLabelResolver = (kind: EntityKind, id: string) => string;

export interface ExportOptions {
  resolveLabel: EntityLabelResolver;
  // URI scheme for entityLink targets. Patches and elements share the same
  // form; consumers reading the markdown back are responsible for parsing.
  uriScheme?: string;
}

const DEFAULT_SCHEME = 'drifting://entity';

// Convert a TipTap/ProseMirror document to a Markdown string. Best-effort
// fidelity for the editor's actual schema (StarterKit + Underline + Link +
// TextAlign + EntityLink). Block-level alignment is not encoded — Markdown
// doesn't have a portable representation. Underline is rendered as `<u>...</u>`
// since CommonMark has no native form.
export function exportDocToMarkdown(doc: PMNode, options: ExportOptions): string {
  const ctx: Context = {
    options,
    listStack: [],
    out: [],
  };
  doc.forEach((child) => renderBlock(child, ctx));
  // Trim trailing whitespace per line and collapse 3+ blank lines.
  return ctx.out
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n';
}

interface Context {
  options: ExportOptions;
  // Tracks nested lists so list-item bullets/numbers use the right prefix.
  listStack: Array<{ kind: 'bullet' | 'ordered'; index: number }>;
  out: string[];
}

function renderBlock(node: PMNode, ctx: Context): void {
  const t = node.type.name;
  switch (t) {
    case 'paragraph': {
      ctx.out.push(renderInline(node, ctx));
      ctx.out.push('\n\n');
      return;
    }
    case 'heading': {
      const level = Math.max(1, Math.min(6, (node.attrs.level as number) ?? 1));
      ctx.out.push('#'.repeat(level));
      ctx.out.push(' ');
      ctx.out.push(renderInline(node, ctx));
      ctx.out.push('\n\n');
      return;
    }
    case 'blockquote': {
      const inner = renderChildrenToString(node, ctx).trimEnd();
      ctx.out.push(
        inner
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n'),
      );
      ctx.out.push('\n\n');
      return;
    }
    case 'codeBlock': {
      const lang = (node.attrs.language as string | null) ?? '';
      ctx.out.push('```');
      ctx.out.push(lang);
      ctx.out.push('\n');
      ctx.out.push(node.textContent);
      ctx.out.push('\n```\n\n');
      return;
    }
    case 'bulletList': {
      ctx.listStack.push({ kind: 'bullet', index: 0 });
      node.forEach((child) => renderBlock(child, ctx));
      ctx.listStack.pop();
      ctx.out.push('\n');
      return;
    }
    case 'orderedList': {
      ctx.listStack.push({ kind: 'ordered', index: 0 });
      node.forEach((child) => renderBlock(child, ctx));
      ctx.listStack.pop();
      ctx.out.push('\n');
      return;
    }
    case 'listItem': {
      const top = ctx.listStack[ctx.listStack.length - 1];
      if (!top) {
        // Defensive: orphaned list item; render as paragraph.
        ctx.out.push(renderInline(node, ctx));
        ctx.out.push('\n');
        return;
      }
      top.index += 1;
      const bullet = top.kind === 'ordered' ? `${top.index}.` : '-';
      const indent = '  '.repeat(Math.max(0, ctx.listStack.length - 1));
      const inner = renderChildrenToString(node, ctx).trimEnd();
      // Indent continuation lines under the bullet.
      const continuationIndent = indent + ' '.repeat(bullet.length + 1);
      const firstLineBreak = inner.indexOf('\n');
      if (firstLineBreak === -1) {
        ctx.out.push(`${indent}${bullet} ${inner}\n`);
      } else {
        const head = inner.slice(0, firstLineBreak);
        const rest = inner
          .slice(firstLineBreak + 1)
          .split('\n')
          .map((line) => (line ? continuationIndent + line : ''))
          .join('\n');
        ctx.out.push(`${indent}${bullet} ${head}\n${rest}\n`);
      }
      return;
    }
    case 'horizontalRule': {
      ctx.out.push('---\n\n');
      return;
    }
    case 'hardBreak': {
      ctx.out.push('  \n');
      return;
    }
    default: {
      // Unknown block: dump its text content as a paragraph fallback so we
      // never silently drop user content.
      const text = node.textContent;
      if (text) {
        ctx.out.push(text);
        ctx.out.push('\n\n');
      } else {
        node.forEach((child) => renderBlock(child, ctx));
      }
      return;
    }
  }
}

// Render a block-bearing parent's children to a string buffer so callers
// can post-process (e.g. indenting blockquote / list-item continuations).
function renderChildrenToString(node: PMNode, ctx: Context): string {
  const saved = ctx.out;
  const buf: string[] = [];
  ctx.out = buf;
  node.forEach((child) => {
    // List items contain paragraphs; render them as inline runs separated by
    // single newlines so the markdown bullet keeps everything compact.
    if (child.type.name === 'paragraph') {
      buf.push(renderInline(child, ctx));
      buf.push('\n');
    } else {
      renderBlock(child, ctx);
    }
  });
  ctx.out = saved;
  return buf.join('');
}

// Inline rendering: walk text nodes, group adjacent runs by mark set so we
// emit balanced `**...**` / `*...*` / etc.
function renderInline(node: PMNode, ctx: Context): string {
  const parts: string[] = [];
  node.forEach((child) => {
    if (child.isText && child.text) {
      parts.push(applyMarks(child.text, child.marks, ctx));
    } else if (child.type.name === 'hardBreak') {
      parts.push('  \n');
    } else if (child.isInline) {
      parts.push(child.textContent);
    } else {
      // Block child inside an inline context — should not happen; skip.
    }
  });
  return parts.join('');
}

function applyMarks(text: string, marks: readonly PMMark[], ctx: Context): string {
  if (!marks || marks.length === 0) return escapeMarkdownText(text);

  // entityLink has highest binding precedence — it owns the whole token and
  // wraps with a link. After that, apply formatting marks from outermost to
  // innermost in a stable order.
  const entityLink = marks.find((m) => m.type.name === 'entityLink');
  const link = marks.find((m) => m.type.name === 'link');
  const bold = marks.some((m) => m.type.name === 'bold');
  const italic = marks.some((m) => m.type.name === 'italic');
  const code = marks.some((m) => m.type.name === 'code');
  const strike = marks.some((m) => m.type.name === 'strike');
  const underline = marks.some((m) => m.type.name === 'underline');

  // Code mark suppresses other formatting by markdown convention.
  let body = code ? `\`${text}\`` : escapeMarkdownText(text);
  if (!code) {
    if (bold) body = `**${body}**`;
    if (italic) body = `*${body}*`;
    if (strike) body = `~~${body}~~`;
    if (underline) body = `<u>${body}</u>`;
  }

  if (entityLink) {
    const scheme = ctx.options.uriScheme ?? DEFAULT_SCHEME;
    const targetKind = (entityLink.attrs.targetKind as EntityKind) ?? 'element';
    const targetId = entityLink.attrs.targetId as string | null;
    const targetBlockId = entityLink.attrs.targetBlockId as string | null;
    if (targetId) {
      const url =
        `${scheme}/${targetKind}/${targetId}` +
        (targetBlockId ? `#${targetBlockId}` : '');
      // Prefer the resolved current label as the link text, falling back to
      // the visible text run when the entity is gone.
      const label = ctx.options.resolveLabel(targetKind, targetId) || text;
      return `[${escapeMarkdownText(label)}](${url})`;
    }
  }

  if (link) {
    const href = (link.attrs.href as string | null) ?? '';
    if (href) return `[${body}](${href})`;
  }

  return body;
}

// Markdown special characters that need escaping inside normal text. We avoid
// over-escaping (which would clutter output) by only escaping the most
// problematic chars at common positions.
function escapeMarkdownText(text: string): string {
  return text.replace(/([\\`*_{}\[\]()#+\-!])/g, '\\$1');
}
