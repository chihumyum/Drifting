/**
 * Markdown / plain text → ProseMirror JSON.
 *
 * Pipeline: `marked` produces HTML, then Tiptap's `generateJSON` runs the
 * project's editor schema over it. This means whatever the editor renders
 * the parser can recover (headings, blockquote, bold/italic, links).
 * Anything the editor doesn't support — lists, code blocks, inline code —
 * degrades to plain paragraphs/text, since those nodes aren't in the schema.
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
import { takeTitle } from './title';
import type { ParsedDoc } from './types';

// Mirror the runtime editor's extension set so the parser's output is
// guaranteed valid under the same schema. Drift here would cause silent
// content loss on import — better to assert by sharing.
const PARSER_EXTENSIONS = [
  StarterKit.configure({
    // Mirror the editor (useEntityEditor): a novel-writing surface with no
    // lists or code. Dropping these from the parser schema makes ProseMirror
    // descend through <ul>/<ol>/<li> into paragraphs and flatten <pre>/<code>
    // to plain text, instead of emitting nodes the editor can't load.
    bulletList: false,
    orderedList: false,
    listItem: false,
    listKeymap: false,
    code: false,
    codeBlock: false,
  }),
  Underline,
  Link.configure({ openOnClick: false, autolink: true }),
  TextAlign.configure({ types: ['heading', 'paragraph'] }),
  EntityLink,
];

export async function parseMarkdown(file: File): Promise<ParsedDoc> {
  const raw = await file.text();
  // `marked` is sync by default and ships its own HTML escape; we keep
  // the defaults so anything weird falls back to text rather than html
  // injection. The editor never runs html anyway — Tiptap is the gate.
  const html = marked.parse(raw, { async: false }) as string;
  const { doc, title } = takeTitle(generateJSON(html, PARSER_EXTENSIONS) as JSONContent, file.name);
  return {
    doc,
    guessedTitle: title,
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

  const { doc, title } = takeTitle({ type: 'doc', content }, file.name);
  return {
    doc,
    guessedTitle: title,
    filename: file.name,
    format: 'txt',
  };
}
