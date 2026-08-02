import { getSchema } from '@tiptap/core';
import { DOMSerializer, Node as PMNode, type Schema } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import TextAlign from '@tiptap/extension-text-align';
import loglevel from 'loglevel';

import { BlockId } from '../../lib/extensions/block-id';
import { ParagraphIndent } from '../../lib/extensions/paragraph-indent';
import {
  applyEntityLinkTargetColors,
  EntityLink,
  type EntityLinkTargetColorResolver,
} from '../../lib/extensions/entity-link';

const log = loglevel.getLogger('chapter-static-html');
log.setLevel(loglevel.levels.WARN);

// Render a chapter's persisted ProseMirror JSON to the SAME HTML the live
// editor produces, without spinning up a ProseMirror EditorView / Yjs / Copilot.
// The all-chapters read-through uses this so every row carries real prose at its
// real rendered height — the placeholder estimate is what made fast scrolls
// jump. Height parity is structural: the caller drops this HTML into a
// `.page__body .ProseMirror` container, so the exact same CSS (font, line-height,
// paragraph spacing, heading sizes) applies as in the editor. Only the focused
// chapter upgrades to a full ChapterEditor.
//
// The schema must include every node/mark a chapter can contain — crucially the
// `entityLink` MARK, or DOMSerializer would choke on it. It mirrors
// useEntityEditor's schema-bearing extensions (StarterKit minus lists/code,
// Underline, Link, TextAlign, BlockId, ParagraphIndent, EntityLink); the
// plugin-only extensions (Collaboration, slash menu, mention suggestion, agent
// decorations) add nothing to the schema and are omitted.

let cachedSchema: Schema | null = null;
let schemaFailed = false;

// Exported for tests: lets a node-side spec assert the schema actually carries
// every node/mark a chapter can hold (esp. the entityLink mark) without needing
// a DOM. Returns null only if construction threw.
export function getStaticChapterSchema(): Schema | null {
  if (cachedSchema) return cachedSchema;
  if (schemaFailed) return null;
  try {
    cachedSchema = getSchema([
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
        code: false,
        codeBlock: false,
        underline: false,
        link: false,
      }),
      Underline,
      Link.configure({ openOnClick: false, autolink: true }),
      TextAlign.configure({
        types: ['heading', 'paragraph'],
        alignments: ['left', 'center', 'right'],
        defaultAlignment: 'left',
      }),
      BlockId,
      ParagraphIndent,
      EntityLink,
    ]);
    return cachedSchema;
  } catch (err) {
    // Never let a schema problem crash the read-through — degrade to plain text.
    schemaFailed = true;
    log.error('Failed to build static chapter schema; falling back to plain text', err);
    return null;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Last-resort renderer when the schema/serializer is unavailable: pull whatever
// text we can out of the doc JSON so the row still shows prose at a believable
// height rather than collapsing.
function fallbackHtml(contentJson: string): string {
  try {
    const json = JSON.parse(contentJson) as { content?: unknown[] };
    const blocks: string[] = [];
    const walk = (node: { type?: string; text?: string; content?: unknown[] }): string => {
      if (node.text) return node.text;
      if (Array.isArray(node.content)) {
        return node.content.map((c) => walk(c as never)).join('');
      }
      return '';
    };
    for (const block of json.content ?? []) {
      const text = walk(block as never).trim();
      if (text) blocks.push(`<p>${escapeHtml(text)}</p>`);
    }
    return blocks.join('');
  } catch {
    return '';
  }
}

// Serialize a chapter's contentJson to HTML. Returns '' for empty/absent content.
export function chapterJsonToHtml(
  contentJson: string | null | undefined,
  resolveTargetColor?: EntityLinkTargetColorResolver,
): string {
  if (!contentJson) return '';
  const schema = getStaticChapterSchema();
  if (schema) {
    try {
      const json = JSON.parse(contentJson);
      const doc = PMNode.fromJSON(schema, json);
      const fragment = DOMSerializer.fromSchema(schema).serializeFragment(doc.content);
      const container = document.createElement('div');
      container.appendChild(fragment);
      if (resolveTargetColor) applyEntityLinkTargetColors(container, resolveTargetColor);
      return container.innerHTML;
    } catch (err) {
      log.warn('Static chapter serialize failed; falling back to plain text', err);
    }
  }
  return fallbackHtml(contentJson);
}
