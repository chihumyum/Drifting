import type { JSONContent } from '@tiptap/core';

import type { YjsProseBlock, YjsProseOperation } from './yjs-prose-command';

/**
 * Passage edits on a material note, planned on its Markdown.
 *
 * A note is shown to the Agent as the blank-line-joined Markdown of its
 * top-level blocks (note-markdown.ts). An edit finds its `currentText` in that
 * text, re-parses only the blocks the passage touches and leaves every other
 * block — its id, marks, embeds and TODO links — exactly as it was.
 */
export interface NoteTextChange {
  currentText: string;
  revisedText: string;
  allOccurrences?: boolean;
}

export interface NoteMarkdownCodec {
  /** Markdown of each top-level node ('' for an empty one). */
  render(nodes: readonly JSONContent[]): string[];
  /** Top-level nodes for a Markdown passage; never empty. */
  parse(markdown: string): JSONContent[];
}

/** A top-level block after planning: an untouched original or a parsed one. */
export type PlannedNoteBlock =
  | { kind: 'kept'; index: number; node: JSONContent }
  | { kind: 'new'; node: JSONContent };

export interface PlannedNoteRevision {
  blocks: PlannedNoteBlock[];
  replacements: number;
}

const SEPARATOR = '\n\n';

interface Span {
  start: number;
  end: number;
}

function joined(markdown: readonly string[]): { text: string; spans: Span[] } {
  let text = '';
  const spans: Span[] = [];
  for (const value of markdown) {
    if (!value) {
      spans.push({ start: text.length, end: text.length });
      continue;
    }
    if (text) text += SEPARATOR;
    spans.push({ start: text.length, end: text.length + value.length });
    text += value;
  }
  return { text, spans };
}

function occurrences(text: string, needle: string): number[] {
  const found: number[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) return found;
    found.push(at);
    from = at + needle.length;
  }
}

/** The inclusive block range a passage [start, end) touches. */
function touchedRange(spans: readonly Span[], start: number, end: number): [number, number] {
  let first = -1;
  let last = -1;
  spans.forEach((span, index) => {
    if (span.start === span.end) return;
    if (span.end > start && span.start < end) {
      if (first < 0) first = index;
      last = index;
    }
  });
  if (first >= 0) return [first, last];
  // A passage that only covers a separator belongs to the block before it.
  const before = spans.reduce((found, span, index) => (span.end <= start && span.start !== span.end ? index : found), -1);
  const index = Math.max(0, before);
  return [index, index];
}

export function planNoteRevision(
  nodes: readonly JSONContent[],
  changes: readonly NoteTextChange[],
  codec: NoteMarkdownCodec,
): PlannedNoteRevision {
  let blocks: PlannedNoteBlock[] = nodes.map((node, index) => ({ kind: 'kept', index, node }));
  let markdown = codec.render(nodes);
  let replacements = 0;

  changes.forEach((change, changeIndex) => {
    if (!change.currentText) throw new Error(`changes[${changeIndex}].currentText must not be empty`);
    const view = joined(markdown);
    const found = occurrences(view.text, change.currentText);
    if (found.length === 0) {
      throw new Error(`changes[${changeIndex}] 的原文不在当前笔记中；先用 read_material 读取最新内容`);
    }
    if (found.length > 1 && !change.allOccurrences) {
      throw new Error(
        `changes[${changeIndex}] 的原文在笔记中出现了 ${found.length} 次；扩大原文范围使其唯一，或设置 allOccurrences`,
      );
    }
    // Apply from the end so earlier offsets stay valid.
    for (const at of [...found].reverse()) {
      const current = joined(markdown);
      const [from, to] = touchedRange(current.spans, at, at + change.currentText.length);
      const regionStart = current.spans[from]!.start;
      const regionEnd = current.spans[to]!.end;
      const region = current.text.slice(regionStart, regionEnd);
      const local = at - regionStart;
      const revised =
        region.slice(0, local) + change.revisedText + region.slice(local + change.currentText.length);
      const replaced = blocks.slice(from, to + 1).map((block) => block.node);
      const parsed = revised.trim() ? carryTaskLinks(replaced, codec.parse(revised)) : [];
      blocks = [...blocks.slice(0, from), ...parsed.map((node): PlannedNoteBlock => ({ kind: 'new', node })), ...blocks.slice(to + 1)];
      markdown = [...markdown.slice(0, from), ...codec.render(parsed), ...markdown.slice(to + 1)];
      replacements += 1;
    }
  });
  if (blocks.length === 0) blocks = [{ kind: 'new', node: codec.parse('')[0]! }];
  return { blocks, replacements };
}

/**
 * Re-parsed checklist lines keep the TODO they were linked to when their text
 * is unchanged; an edited or new line is projected as a new task by the note
 * editor, as if the author had typed it.
 */
export function carryTaskLinks(previous: readonly JSONContent[], next: readonly JSONContent[]): JSONContent[] {
  const available = new Map<string, string[]>();
  const collect = (node: JSONContent) => {
    if (node.type === 'taskItem' && typeof node.attrs?.todoId === 'string' && node.attrs.todoId) {
      const text = ownTaskText(node);
      available.set(text, [...(available.get(text) ?? []), node.attrs.todoId]);
    }
    node.content?.forEach(collect);
  };
  previous.forEach(collect);
  if (available.size === 0) return [...next];
  const relink = (node: JSONContent): JSONContent => {
    const content = node.content?.map(relink);
    if (node.type !== 'taskItem') return content ? { ...node, content } : node;
    const ids = available.get(ownTaskText(node));
    const todoId = ids?.shift();
    return {
      ...node,
      attrs: { ...node.attrs, ...(todoId ? { todoId } : {}) },
      ...(content ? { content } : {}),
    };
  };
  return next.map(relink);
}

function ownTaskText(node: JSONContent): string {
  const parts: string[] = [];
  const walk = (current: JSONContent) => {
    if (typeof current.text === 'string') parts.push(current.text);
    for (const child of current.content ?? []) {
      if (child.type === 'taskList') continue;
      walk(child);
    }
  };
  walk(node);
  return parts.join('').trim();
}

/**
 * The single prose operation that turns `base` into the planned blocks.
 * `converted` holds the Yjs blocks of every `new` entry, in order. Untouched
 * blocks between two edits are kept by editing in place whenever the block
 * count is unchanged; otherwise the smallest covering range is replaced.
 */
export function noteBlocksOperation(
  base: readonly YjsProseBlock[],
  planned: readonly PlannedNoteBlock[],
  converted: readonly YjsProseBlock[],
): YjsProseOperation | null {
  let next = 0;
  const final = planned.map((block) => {
    if (block.kind === 'kept') return { kept: true as const, block: base[block.index]! };
    const value = converted[next++];
    if (!value) throw new Error('A planned note block was not converted');
    return { kept: false as const, block: value };
  });
  const same = (index: number, finalIndex: number) => {
    const candidate = final[finalIndex];
    return Boolean(candidate?.kept && candidate.block.id === base[index]?.id);
  };
  let prefix = 0;
  while (prefix < base.length && prefix < final.length && same(prefix, prefix)) prefix += 1;
  if (prefix === base.length && prefix === final.length) return null;
  let suffix = 0;
  while (
    suffix < base.length - prefix &&
    suffix < final.length - prefix &&
    same(base.length - 1 - suffix, final.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  const removed = base.slice(prefix, base.length - suffix);
  const inserted = final.slice(prefix, final.length - suffix);

  // An edit in place is exact only when every kept block stays where it was;
  // a rewritten block then keeps its top-level id, so anchors on it survive.
  if (
    removed.length === inserted.length &&
    removed.length > 0 &&
    inserted.every((entry, index) => !entry.kept || entry.block.id === removed[index]!.id)
  ) {
    const edits = removed
      .map((block, index) => ({ block, next: inserted[index]! }))
      .filter(({ next: candidate }) => !candidate.kept)
      .map(({ block, next: candidate }) => ({ blockId: block.id, block: { ...candidate.block, id: block.id } }));
    if (edits.length === 1) return { kind: 'edit', blockId: edits[0]!.blockId, block: edits[0]!.block };
    if (edits.length > 1) return { kind: 'edit_many', edits };
  }
  const blocks = inserted.map((entry) => entry.block);
  if (removed.length === 0) {
    return { kind: 'insert', afterBlockId: prefix > 0 ? base[prefix - 1]!.id : null, blocks };
  }
  if (blocks.length === 0) return { kind: 'remove', blockIds: removed.map((block) => block.id) };
  return { kind: 'replace', fromBlockId: removed[0]!.id, toBlockId: removed[removed.length - 1]!.id, blocks };
}
