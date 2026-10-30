/**
 * Turns "the blocks this file asks for" into the smallest Yjs edits on a
 * fork of the file's base state (docs/markdown-mirror.md).
 *
 * The Agent replaces a whole block element when it edits one. A file edit is
 * merged as a concurrent peer instead, so it must change only the characters
 * that changed: a sentence Drifting edited meanwhile in the same paragraph
 * keeps its place, and two edits to one paragraph never produce two elements
 * with the same block id.
 */
import * as Y from 'yjs';

import {
  createYjsProseBlock,
  createYjsProseElement,
  createYjsProseText,
  type YjsJsonValue,
  type YjsProseBlock,
  type YjsProseElementNode,
  type YjsProseNode,
  type YjsProseTextNode,
} from '../../lib/agent/runtime/yjs-prose-command';
import { isEntityLinkMarkKey } from '../../lib/location-link';

/** A paragraph pair larger than this is replaced between its common ends. */
const MAX_DIFF_CELLS = 1_000_000;

type Marks = Record<string, YjsJsonValue>;

function stable(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
    .join(',')}}`;
}

/** Entity links are re-derived from names; a file never adds or removes them. */
function authoredMarks(marks: Readonly<Record<string, unknown>> | undefined): Marks {
  const result: Marks = {};
  for (const [key, value] of Object.entries(marks ?? {})) {
    if (!isEntityLinkMarkKey(key) && value !== null && value !== undefined) {
      result[key] = value as YjsJsonValue;
    }
  }
  return result;
}

/**
 * Edits `fragment` in place so its blocks equal `desired`. Surviving blocks
 * must keep their relative order. Returns the ids of blocks that changed.
 */
export function reconcileProseBlocks(
  fragment: Y.XmlFragment,
  desired: readonly YjsProseBlock[],
): string[] {
  const wanted = new Set(desired.map((block) => block.id));
  if (wanted.size !== desired.length) throw new Error('Desired prose blocks repeat an id');
  const touched = new Set<string>();
  const children = fragment.toArray();
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    const id = child instanceof Y.XmlElement ? child.getAttribute('id') : undefined;
    if (typeof id !== 'string' || !wanted.has(id)) {
      fragment.delete(index, 1);
      if (typeof id === 'string') touched.add(id);
    }
  }
  let at = 0;
  for (const block of desired) {
    const child = at < fragment.length ? fragment.get(at) : undefined;
    if (child instanceof Y.XmlElement && child.getAttribute('id') === block.id) {
      if (child.nodeName !== block.type) {
        fragment.delete(at, 1);
        fragment.insert(at, [createYjsProseBlock(block)]);
        touched.add(block.id);
      } else if (reconcileElement(child, { ...(block.attrs ?? {}), id: block.id }, block.content ?? [])) {
        touched.add(block.id);
      }
    } else {
      fragment.insert(at, [createYjsProseBlock(block)]);
      touched.add(block.id);
    }
    at += 1;
  }
  if (fragment.length !== desired.length) {
    throw new Error('Prose blocks changed order; the file cannot be merged in place');
  }
  return [...touched];
}

function reconcileElement(
  element: Y.XmlElement,
  attrs: Readonly<Record<string, YjsJsonValue>>,
  content: readonly YjsProseNode[],
): boolean {
  let changed = false;
  const current = element.getAttributes() as Record<string, unknown>;
  for (const key of new Set([...Object.keys(current), ...Object.keys(attrs)])) {
    const want = attrs[key];
    if (want === undefined) {
      element.removeAttribute(key);
      changed = true;
    } else if (stable(current[key]) !== stable(want)) {
      // y-prosemirror stores JSON attribute values (heading level is a number).
      element.setAttribute(key, want as string);
      changed = true;
    }
  }
  return reconcileChildren(element, content) || changed;
}

type Segment =
  | { kind: 'text'; runs: YjsProseTextNode[] }
  | { kind: 'element'; node: YjsProseElementNode };

function segments(nodes: readonly YjsProseNode[]): Segment[] {
  const result: Segment[] = [];
  for (const node of nodes) {
    if (node.kind === 'element') {
      result.push({ kind: 'element', node });
      continue;
    }
    if (!node.text) continue;
    const last = result[result.length - 1];
    if (last?.kind === 'text') last.runs.push(node);
    else result.push({ kind: 'text', runs: [node] });
  }
  return result;
}

function snapshotChildren(element: Y.XmlElement): unknown[] {
  return element.toArray().flatMap((child): unknown[] => {
    if (child instanceof Y.XmlText) {
      return (child.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[])
        .filter((delta) => typeof delta.insert === 'string' && delta.insert.length > 0)
        .map((delta) => ({ kind: 'text', text: delta.insert, marks: authoredMarks(delta.attributes) }));
    }
    if (child instanceof Y.XmlElement) {
      return [{ kind: 'element', type: child.nodeName, attrs: child.getAttributes(), content: snapshotChildren(child) }];
    }
    return [{ kind: 'unknown' }];
  });
}

function desiredSnapshot(nodes: readonly YjsProseNode[]): unknown[] {
  return nodes.flatMap((node): unknown[] =>
    node.kind === 'text'
      ? node.text
        ? [{ kind: 'text', text: node.text, marks: authoredMarks(node.marks) }]
        : []
      : [{ kind: 'element', type: node.type, attrs: node.attrs ?? {}, content: desiredSnapshot(node.content ?? []) }],
  );
}

function reconcileChildren(element: Y.XmlElement, nodes: readonly YjsProseNode[]): boolean {
  const wanted = segments(nodes);
  const children = element.toArray();
  const sameShape =
    children.length === wanted.length &&
    children.every((child, index) => {
      const segment = wanted[index]!;
      return segment.kind === 'text'
        ? child instanceof Y.XmlText
        : child instanceof Y.XmlElement && child.nodeName === segment.node.type;
    });
  if (!sameShape) {
    if (stable(snapshotChildren(element)) === stable(desiredSnapshot(nodes))) return false;
    // A hard break added or removed: rebuild this block's inline content.
    if (element.length > 0) element.delete(0, element.length);
    const created = wanted.flatMap((segment): Array<Y.XmlElement | Y.XmlText> =>
      segment.kind === 'element'
        ? [createYjsProseElement(segment.node)]
        : segment.runs.map((run) => createYjsProseText(run)),
    );
    if (created.length > 0) element.insert(0, created);
    return true;
  }
  let changed = false;
  children.forEach((child, index) => {
    const segment = wanted[index]!;
    if (segment.kind === 'text') {
      if (reconcileText(child as Y.XmlText, segment.runs)) changed = true;
    } else if (
      reconcileElement(child as Y.XmlElement, segment.node.attrs ?? {}, segment.node.content ?? [])
    ) {
      changed = true;
    }
  });
  return changed;
}

interface Run {
  text: string;
  marks: Marks;
}

function marksAt(runs: readonly Run[], offset: number): Marks {
  let cursor = 0;
  for (const run of runs) {
    if (offset < cursor + run.text.length) return run.marks;
    cursor += run.text.length;
  }
  return runs[runs.length - 1]?.marks ?? {};
}

/** Pieces of `text` starting at `offset` of the desired runs, split where marks change. */
function piecesWithMarks(runs: readonly Run[], offset: number, text: string): Run[] {
  const pieces: Run[] = [];
  let cursor = 0;
  for (const run of runs) {
    const start = Math.max(offset, cursor);
    const end = Math.min(offset + text.length, cursor + run.text.length);
    if (start < end) pieces.push({ text: run.text.slice(start - cursor, end - cursor), marks: run.marks });
    cursor += run.text.length;
  }
  return pieces;
}

type Edit = { kind: 'equal' | 'delete' | 'insert'; text: string };

/** Character diff by code point, so a surrogate pair is never split. */
export function diffText(before: string, after: string): Edit[] {
  const a = Array.from(before);
  const b = Array.from(after);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const left = a.slice(prefix, a.length - suffix);
  const right = b.slice(prefix, b.length - suffix);
  const middle: Edit[] = [];
  if ((left.length + 1) * (right.length + 1) > MAX_DIFF_CELLS) {
    if (left.length) middle.push({ kind: 'delete', text: left.join('') });
    if (right.length) middle.push({ kind: 'insert', text: right.join('') });
  } else {
    const width = right.length + 1;
    const table = new Uint32Array((left.length + 1) * width);
    for (let i = left.length - 1; i >= 0; i -= 1) {
      for (let j = right.length - 1; j >= 0; j -= 1) {
        table[i * width + j] =
          left[i] === right[j]
            ? 1 + table[(i + 1) * width + j + 1]!
            : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    const push = (kind: Edit['kind'], char: string) => {
      const last = middle[middle.length - 1];
      if (last?.kind === kind) last.text += char;
      else middle.push({ kind, text: char });
    };
    while (i < left.length || j < right.length) {
      if (i < left.length && j < right.length && left[i] === right[j]) {
        push('equal', left[i]!);
        i += 1;
        j += 1;
      } else if (j < right.length && (i === left.length || table[i * width + j + 1]! > table[(i + 1) * width + j]!)) {
        push('insert', right[j]!);
        j += 1;
      } else {
        push('delete', left[i]!);
        i += 1;
      }
    }
  }
  return [
    ...(prefix ? [{ kind: 'equal' as const, text: a.slice(0, prefix).join('') }] : []),
    ...middle,
    ...(suffix ? [{ kind: 'equal' as const, text: a.slice(a.length - suffix).join('') }] : []),
  ];
}

function reconcileText(text: Y.XmlText, desiredRuns: readonly YjsProseTextNode[]): boolean {
  const runs: Run[] = desiredRuns.map((run) => ({ text: run.text, marks: authoredMarks(run.marks) }));
  const current = (text.toDelta() as { insert: unknown }[])
    .map((delta) => (typeof delta.insert === 'string' ? delta.insert : ''))
    .join('');
  const wanted = runs.map((run) => run.text).join('');
  let changed = false;
  let cursor = 0;
  let desiredOffset = 0;
  for (const edit of diffText(current, wanted)) {
    if (edit.kind === 'equal') {
      cursor += edit.text.length;
      desiredOffset += edit.text.length;
    } else if (edit.kind === 'delete') {
      text.delete(cursor, edit.text.length);
      changed = true;
    } else {
      for (const piece of piecesWithMarks(runs, desiredOffset, edit.text)) {
        // Explicit attributes: inserted text takes exactly these marks and
        // never inherits a neighbouring entity link.
        text.insert(cursor, piece.text, { ...piece.marks });
        cursor += piece.text.length;
      }
      desiredOffset += edit.text.length;
      changed = true;
    }
  }
  // Formatting: apply the marks the file asks for where they differ.
  let offset = 0;
  for (const delta of text.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
    if (typeof delta.insert !== 'string') continue;
    const have = authoredMarks(delta.attributes);
    let start = 0;
    while (start < delta.insert.length) {
      const want = marksAt(runs, offset + start);
      let end = start + 1;
      while (end < delta.insert.length && stable(marksAt(runs, offset + end)) === stable(want)) end += 1;
      if (stable(have) !== stable(want)) {
        const patch: Record<string, unknown> = { ...want };
        for (const key of Object.keys(have)) if (!(key in want)) patch[key] = null;
        text.format(offset + start, end - start, patch);
        changed = true;
      }
      start = end;
    }
    offset += delta.insert.length;
  }
  return changed;
}
