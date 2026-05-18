/**
 * Markdown / plain text → ProseMirror JSON.
 *
 * Pipeline: `marked` produces HTML, then Tiptap's `generateJSON` runs the
 * project's editor schema over it. This means whatever the editor renders
 * the parser can recover (headings, lists, blockquote, code, bold/italic,
 * links). Anything else degrades to a paragraph.
 *
 * Plain text takes a faster path — split on blank lines, each paragraph
 * becomes its own block. No markdown interpretation, which is correct:
 * the user said the file is .txt.
 */
import { generateJSON } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import TextAlign from '@tiptap/extension-text-align';
import { marked } from 'marked';
import type { JSONContent } from '@tiptap/core';
import { EntityLink } from '../../lib/extensions/entity-link';
import type { ParsedDoc } from './types';

// Mirror the runtime editor's extension set so the parser's output is
// guaranteed valid under the same schema. Drift here would cause silent
// content loss on import — better to assert by sharing.
const PARSER_EXTENSIONS = [
  StarterKit.configure({
    codeBlock: { HTMLAttributes: { class: 'code-block' } },
  }),
  Underline,
  Link.configure({ openOnClick: false, autolink: true }),
  TextAlign.configure({ types: ['heading', 'paragraph'] }),
  EntityLink,
];

function guessTitleFromMarkdown(raw: string, fallback: string): string {
  // First H1, or first non-empty line, or the filename stem.
  const h1 = raw.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  const firstLine = raw.split('\n').find((l) => l.trim().length > 0);
  if (firstLine) return firstLine.replace(/^#+\s*/, '').trim().slice(0, 80);
  return fallback;
}

function guessTitleFromText(raw: string, fallback: string): string {
  const firstLine = raw.split(/\r?\n/).find((l) => l.trim().length > 0);
  return firstLine ? firstLine.trim().slice(0, 80) : fallback;
}

function filenameStem(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return (dot > 0 ? filename.slice(0, dot) : filename).trim() || filename;
}

export async function parseMarkdown(file: File): Promise<ParsedDoc> {
  const raw = await file.text();
  // `marked` is sync by default and ships its own HTML escape; we keep
  // the defaults so anything weird falls back to text rather than html
  // injection. The editor never runs html anyway — Tiptap is the gate.
  const html = marked.parse(raw, { async: false }) as string;
  const doc = generateJSON(html, PARSER_EXTENSIONS) as JSONContent;
  return {
    doc,
    guessedTitle: guessTitleFromMarkdown(raw, filenameStem(file.name)),
    filename: file.name,
    format: 'markdown',
  };
}

export async function parseTxt(file: File): Promise<ParsedDoc> {
  const raw = await file.text();
  // Treat blank-line-separated chunks as paragraphs. Single newlines stay
  // inside a paragraph (most writers' .txt drafts use them as soft wrap).
  const paragraphs = raw
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const content: JSONContent[] =
    paragraphs.length === 0
      ? [{ type: 'paragraph' }]
      : paragraphs.map((text) => ({
          type: 'paragraph',
          // Preserve in-paragraph line breaks as `hardBreak` nodes.
          content: text.split(/\r?\n/).flatMap((line, idx, arr) => {
            const t: JSONContent[] = [{ type: 'text', text: line }];
            if (idx < arr.length - 1) t.push({ type: 'hardBreak' });
            return t;
          }),
        }));

  return {
    doc: { type: 'doc', content },
    guessedTitle: guessTitleFromText(raw, filenameStem(file.name)),
    filename: file.name,
    format: 'txt',
  };
}
