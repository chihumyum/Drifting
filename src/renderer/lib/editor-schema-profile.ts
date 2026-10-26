import { getSchema, type AnyExtension } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import TextAlign from '@tiptap/extension-text-align';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import Highlight from '@tiptap/extension-highlight';

import { BlockId } from './extensions/block-id';
import { ParagraphIndent } from './extensions/paragraph-indent';
import { EntityLink } from './extensions/entity-link';
import { Callout, MaterialEmbed } from './extensions/note-blocks';

/**
 * The two editing profiles that share one TipTap/Yjs kernel.
 *
 * - `prose` — chapters, drifts, elements, storylines, categories and patches:
 *   the restrained novel-writing surface (no lists, code, tables).
 * - `note` — material notes (`library_item` kind 'text'): the prose schema plus
 *   lists, task lists, code, tables, highlights, callouts and material embeds.
 *
 * The profile belongs to the document, never to the view, so every headless
 * schema builder (seeding, static HTML, export, Agent reads) and the live
 * editor must agree on it.
 */
export type EditorSchemaProfile = 'prose' | 'note';

export interface SchemaExtensionOptions {
  /** Prose editors keep their own StarterKit undo configuration. */
  undoRedo?: false | { depth: number };
}

/**
 * StarterKit for a profile. `undoRedo` is false whenever a Yjs Collaboration
 * binding owns history; headless schemas never need it.
 */
export function profileStarterKit(profile: EditorSchemaProfile, options: SchemaExtensionOptions = {}) {
  const undoRedo = options.undoRedo === undefined ? false : options.undoRedo;
  if (profile === 'note') {
    return StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      undoRedo,
      underline: false,
      link: false,
    });
  }
  return StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    // Novel-writing surface: no code or lists. Disabling the nodes/marks
    // also strips their input rules and keymaps.
    bulletList: false,
    orderedList: false,
    listItem: false,
    listKeymap: false,
    code: false,
    codeBlock: false,
    undoRedo,
    underline: false,
    link: false,
  });
}

/**
 * Lists and tables own Tab inside their nodes; in notes the block indent is
 * the fallback everywhere else, so its keymap must run after theirs.
 */
export const noteParagraphIndent = ParagraphIndent.extend({ priority: 50 });

/**
 * A note task item may be linked to a TODO (`todoId`); while linked, the
 * TODO's status is authoritative and the checkbox mirrors it.
 */
export const NoteTaskItem = TaskItem.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      todoId: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-todo-id'),
        renderHTML: (attributes: Record<string, unknown>) =>
          typeof attributes.todoId === 'string' ? { 'data-todo-id': attributes.todoId } : {},
      },
    };
  },
});

export interface NoteOnlyExtensionOptions {
  /** The live editor renders embeds with a React node view; schemas do not. */
  materialEmbed?: AnyExtension;
}

/** Nodes and marks only the `note` profile adds on top of the prose schema. */
export function noteOnlyExtensions(options: NoteOnlyExtensionOptions = {}): AnyExtension[] {
  return [
    TaskList,
    NoteTaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    Highlight,
    Callout,
    options.materialEmbed ?? MaterialEmbed,
  ];
}

/**
 * Every schema-bearing extension of a profile, in editor order. Plugin-only
 * editor extensions (Collaboration, placeholder, suggestions, decorations)
 * add nothing to the schema and are composed by the live editor.
 */
export function schemaExtensionsForProfile(
  profile: EditorSchemaProfile,
  options: SchemaExtensionOptions = {},
): AnyExtension[] {
  const shared: AnyExtension[] = [
    profileStarterKit(profile, options),
    Underline,
    Link.configure({ openOnClick: false, autolink: true }),
    TextAlign.configure({
      types: ['heading', 'paragraph'],
      alignments: ['left', 'center', 'right'],
      defaultAlignment: 'left',
    }),
    BlockId,
  ];
  if (profile === 'prose') return [...shared, ParagraphIndent, EntityLink];
  return [...shared, noteParagraphIndent, EntityLink, ...noteOnlyExtensions()];
}

const schemaCache = new Map<EditorSchemaProfile, Schema>();

/** Headless schema for seeding, static rendering and exports. */
export function schemaForProfile(profile: EditorSchemaProfile): Schema {
  const cached = schemaCache.get(profile);
  if (cached) return cached;
  const schema = getSchema(schemaExtensionsForProfile(profile));
  schemaCache.set(profile, schema);
  return schema;
}

/** The profile a Yjs document id belongs to. */
export function profileForDocId(docId: string): EditorSchemaProfile {
  return docId.startsWith('library-item:') ? 'note' : 'prose';
}
