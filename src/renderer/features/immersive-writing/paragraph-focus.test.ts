import type { Editor } from '@tiptap/core';
import { Schema } from '@tiptap/pm/model';
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setActiveEditor } from '../../lib/active-editor';
import {
  IMMERSIVE_DIM_HIGHLIGHT,
  focusedBlockDom,
  rangesAround,
  rangesStillAround,
  startParagraphFocus,
} from './paragraph-focus';

// Plain Node: a DOM just big enough for live-range boundaries.
interface FakeNode { nodeType: number; name: string; parentNode: FakeNode | null; childNodes: FakeNode[]; ownerDocument?: unknown }
function element(name: string, children: FakeNode[] = []): FakeNode {
  const node: FakeNode = { nodeType: 1, name, parentNode: null, childNodes: children };
  children.forEach((child) => { child.parentNode = node; });
  return node;
}
function contains(root: FakeNode, node: FakeNode): boolean {
  for (let current: FakeNode | null = node; current; current = current.parentNode) if (current === root) return true;
  return false;
}
class FakeRange {
  startContainer!: FakeNode; startOffset = 0; endContainer!: FakeNode; endOffset = 0;
  setStart(node: FakeNode, offset: number) { this.startContainer = node; this.startOffset = offset; }
  setEnd(node: FakeNode, offset: number) { this.endContainer = node; this.endOffset = offset; }
  setEndBefore(node: FakeNode) { this.setEnd(node.parentNode!, node.parentNode!.childNodes.indexOf(node)); }
  setStartAfter(node: FakeNode) { this.setStart(node.parentNode!, node.parentNode!.childNodes.indexOf(node) + 1); }
}
function prose(blocks: number) {
  const paragraphs = Array.from({ length: blocks }, (_, index) => element(`p${index}`));
  const root = element('root', paragraphs) as FakeNode & { contains(node: FakeNode): boolean };
  root.ownerDocument = { createRange: () => new FakeRange() };
  root.contains = (node) => contains(root, node);
  return { root, paragraphs };
}

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*' },
    list: { group: 'block', content: 'item+' },
    item: { content: 'paragraph' },
    rule: { group: 'block' },
    text: {},
  },
});

describe('paragraph focus (docs/editor/immersive-writing.md)', () => {
  it('dims the prose on both sides of the caret block, and knows when that no longer holds', () => {
    const { root, paragraphs } = prose(4);
    const ranges = rangesAround(root as unknown as Node, paragraphs[2] as unknown as Node);
    const [before, after] = ranges as unknown as [FakeRange, FakeRange];
    expect([before.startContainer, before.startOffset, before.endContainer, before.endOffset]).toEqual([root, 0, root, 2]);
    expect([after.startContainer, after.startOffset, after.endContainer, after.endOffset]).toEqual([root, 3, root, 4]);
    expect(rangesStillAround(ranges, root as unknown as Node, paragraphs[2] as unknown as Node)).toBe(true);

    // A block inserted right before the caret's lands on a boundary a live
    // range does not stretch over: the ranges are rebuilt.
    const inserted = element('new');
    inserted.parentNode = root;
    root.childNodes.splice(2, 0, inserted);
    expect(rangesStillAround(ranges, root as unknown as Node, paragraphs[2] as unknown as Node)).toBe(false);
  });

  it('finds the textblock holding the selection head, nested or not, or the selected node', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('one')]),
      schema.node('list', null, [schema.node('item', null, [schema.node('paragraph', null, [schema.text('two')])])]),
      schema.node('rule'),
    ]);
    const doms = new Map<number, { nodeType: number; pos: number }>();
    const view = (selection: EditorState['selection']) => ({
      view: {
        state: EditorState.create({ doc, selection }),
        nodeDOM: (pos: number) => {
          if (!doms.has(pos)) doms.set(pos, { nodeType: 1, pos });
          return doms.get(pos);
        },
      },
    }) as unknown as Editor;

    expect(focusedBlockDom(view(TextSelection.create(doc, 2)))).toMatchObject({ pos: 0 });
    // Inside the list item's paragraph: that paragraph, not the list.
    expect(focusedBlockDom(view(TextSelection.create(doc, 9)))).toMatchObject({ pos: 7 });
    const rulePos = doc.content.size - 1;
    expect(focusedBlockDom(view(NodeSelection.create(doc, rulePos)))).toMatchObject({ pos: rulePos });
  });

  describe('the highlight', () => {
    const frames: FrameRequestCallback[] = [];
    const registry = new Map<string, { ranges: Set<unknown> }>();
    class TestHighlight {
      ranges = new Set<unknown>();
      clear() { this.ranges.clear(); }
      add(range: unknown) { this.ranges.add(range); }
    }
    const flush = () => frames.splice(0).forEach((callback) => callback(0));

    beforeEach(() => {
      vi.stubGlobal('Highlight', TestHighlight);
      vi.stubGlobal('CSS', { highlights: registry });
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
      vi.stubGlobal('cancelAnimationFrame', () => undefined);
    });
    afterEach(() => {
      setActiveEditor(null);
      registry.clear();
      frames.length = 0;
      vi.unstubAllGlobals();
    });

    function fakeEditor(root: ReturnType<typeof prose>['root'], block: () => FakeNode) {
      const handlers = new Set<() => void>();
      const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('x')])]);
      return {
        isDestroyed: false,
        view: {
          dom: root,
          state: EditorState.create({ doc, selection: TextSelection.create(doc, 1) }),
          nodeDOM: () => block(),
        },
        on: (_event: string, handler: () => void) => handlers.add(handler),
        off: (_event: string, handler: () => void) => handlers.delete(handler),
        fire: () => handlers.forEach((handler) => handler()),
        handlers,
      };
    }

    it('follows the active editor, repaints only when the caret changes block, and goes on stop', () => {
      const { root, paragraphs } = prose(3);
      let caretBlock = paragraphs[1];
      const editor = fakeEditor(root, () => caretBlock);
      setActiveEditor(editor as unknown as Editor);

      const stop = startParagraphFocus();
      const highlight = registry.get(IMMERSIVE_DIM_HIGHLIGHT)!;
      flush();
      const first = [...highlight.ranges];
      expect(first).toHaveLength(2);

      // Typing inside the same block: the live ranges already hold.
      editor.fire();
      flush();
      expect([...highlight.ranges]).toEqual(first);

      caretBlock = paragraphs[2];
      editor.fire();
      flush();
      const [, after] = [...highlight.ranges] as FakeRange[];
      expect(after.startOffset).toBe(3);

      stop();
      expect(registry.has(IMMERSIVE_DIM_HIGHLIGHT)).toBe(false);
      expect(editor.handlers.size).toBe(0);
    });

    it('does nothing where the highlight API is missing', () => {
      vi.stubGlobal('CSS', {});
      const stop = startParagraphFocus();
      expect(registry.size).toBe(0);
      expect(stop).not.toThrow();
    });
  });
});
