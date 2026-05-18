/**
 * A standalone ProseMirror schema matching the runtime editor extension
 * set. Used by export pipelines that need to parse stored JSON without
 * mounting a live Tiptap editor.
 *
 * Keep in sync with the editor configuration in
 * `src/renderer/hooks/useEntityEditor.ts`. If extensions diverge between
 * the two, exported documents would silently drop or rename nodes.
 */
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import TextAlign from '@tiptap/extension-text-align';
import { Schema } from '@tiptap/pm/model';
import { EntityLink } from './entity-link';

let cached: Schema | null = null;

export function getBookSchema(): Schema {
  if (cached) return cached;
  cached = getSchema([
    StarterKit.configure({
      codeBlock: { HTMLAttributes: { class: 'code-block' } },
    }),
    Underline,
    Link.configure({ openOnClick: false, autolink: true }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    EntityLink,
  ]);
  return cached;
}
