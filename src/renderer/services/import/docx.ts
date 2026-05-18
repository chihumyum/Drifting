/**
 * DOCX → ProseMirror JSON via mammoth.
 *
 * Mammoth converts DOCX to clean HTML — it discards Word's styling
 * minutiae (font, color, mysterious spacings) and emits semantic tags
 * (h1..h6, p, ul/ol/li, strong, em, blockquote). We then run Tiptap's
 * `generateJSON` over that HTML so we land in the same JSON shape as
 * markdown imports.
 *
 * Images: mammoth can convert images to data URIs, but the editor's
 * StarterKit doesn't currently render images. We drop them with a
 * warning so the user sees in the dialog that something was lost.
 */
import * as mammoth from 'mammoth';
import { generateJSON } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import TextAlign from '@tiptap/extension-text-align';
import type { JSONContent } from '@tiptap/core';
import { EntityLink } from '../../lib/extensions/entity-link';
import type { ParsedDoc } from './types';

const PARSER_EXTENSIONS = [
  StarterKit.configure({
    codeBlock: { HTMLAttributes: { class: 'code-block' } },
  }),
  Underline,
  Link.configure({ openOnClick: false, autolink: true }),
  TextAlign.configure({ types: ['heading', 'paragraph'] }),
  EntityLink,
];

function filenameStem(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return (dot > 0 ? filename.slice(0, dot) : filename).trim() || filename;
}

function guessTitle(html: string, fallback: string): string {
  // Mammoth emits <h1>title</h1> when the docx has a Title or Heading 1
  // at the top of the body. Fall back to the filename stem.
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (m) {
    const text = m[1].replace(/<[^>]+>/g, '').trim();
    if (text) return text.slice(0, 80);
  }
  return fallback;
}

export async function parseDocx(file: File): Promise<ParsedDoc> {
  const buf = await file.arrayBuffer();
  // mammoth ignores images by default in `convertToHtml`; we don't
  // configure transformImage so they're dropped quietly. Track that in
  // a warning so the importer can surface it.
  const result = await mammoth.convertToHtml(
    { arrayBuffer: buf },
    {
      // Style map: lets us promote Word's "Title" and "Heading 1" to the
      // same h1, and "Quote" to <blockquote>. Defaults already handle
      // most cases; we just add the common Word style names so Chinese
      // localizations also map correctly.
      styleMap: [
        "p[style-name='Title'] => h1:fresh",
        "p[style-name='标题 1'] => h1:fresh",
        "p[style-name='标题 2'] => h2:fresh",
        "p[style-name='标题 3'] => h3:fresh",
        "p[style-name='Quote'] => blockquote",
      ],
    },
  );

  const html = result.value;
  const doc = generateJSON(html, PARSER_EXTENSIONS) as JSONContent;
  const warnings: string[] = [];
  if (/<img\b/i.test(html)) warnings.push('图片未导入（编辑器暂不支持嵌入图片）。');
  for (const m of result.messages ?? []) {
    if (m.type === 'warning') warnings.push(m.message);
  }

  return {
    doc,
    guessedTitle: guessTitle(html, filenameStem(file.name)),
    filename: file.name,
    format: 'docx',
    warnings: warnings.length ? warnings : undefined,
  };
}
