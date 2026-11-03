import type { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { getActiveEditor, subscribeActiveEditor } from '../../lib/active-editor';

/**
 * Paragraph focus for immersive writing: every block but the one holding the
 * caret fades. The fade is a CSS Custom Highlight over the prose before and
 * after that block (`::highlight(drifting-immersive-dim)` in
 * immersive-writing.css), so the editor's DOM, its decorations and an IME
 * composition are never touched. Both ranges are live: typing inside the
 * block moves nothing, and they are rebuilt only when the caret reaches
 * another block or the blocks around it change place.
 */
export const IMMERSIVE_DIM_HIGHLIGHT = 'drifting-immersive-dim';

/** The DOM of the textblock holding the selection head, or the selected node. */
export function focusedBlockDom(editor: Editor): HTMLElement | null {
  const { view } = editor;
  const { selection } = view.state;
  if (selection instanceof NodeSelection) return asElement(view.nodeDOM(selection.from));
  const { $head } = selection;
  for (let depth = $head.depth; depth > 0; depth -= 1) {
    if ($head.node(depth).isTextblock) return asElement(view.nodeDOM($head.before(depth)));
  }
  return null;
}

function asElement(node: Node | null): HTMLElement | null {
  return node?.nodeType === 1 ? (node as HTMLElement) : null;
}

/** The prose of `root` before `block` and after it. */
export function rangesAround(root: Node, block: Node): [Range, Range] {
  const doc = root.ownerDocument ?? document;
  const before = doc.createRange();
  before.setStart(root, 0);
  before.setEndBefore(block);
  const after = doc.createRange();
  after.setStartAfter(block);
  after.setEnd(root, root.childNodes.length);
  return [before, after];
}

/** Whether two ranges from `rangesAround` still meet `block` on both sides. */
export function rangesStillAround(ranges: readonly [Range, Range], root: Node, block: Node): boolean {
  const parent = block.parentNode;
  if (!parent || !root.contains(block)) return false;
  const index = Array.prototype.indexOf.call(parent.childNodes, block) as number;
  const [before, after] = ranges;
  return before.startContainer === root && before.startOffset === 0
    && before.endContainer === parent && before.endOffset === index
    && after.startContainer === parent && after.startOffset === index + 1
    && after.endContainer === root && after.endOffset === root.childNodes.length;
}

function highlightsSupported(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';
}

/** Starts fading everything but the focused editor's current block; returns the stop. */
export function startParagraphFocus(): () => void {
  if (!highlightsSupported()) return () => undefined;
  const highlight = new Highlight();
  CSS.highlights.set(IMMERSIVE_DIM_HIGHLIGHT, highlight);
  let editor: Editor | null = null;
  let painted: { block: HTMLElement; ranges: [Range, Range] } | null = null;
  let frame = 0;

  const paint = () => {
    frame = 0;
    const block = editor && !editor.isDestroyed ? focusedBlockDom(editor) : null;
    const root = editor && !editor.isDestroyed ? editor.view.dom : null;
    if (!root || !block || !root.contains(block)) {
      highlight.clear();
      painted = null;
      return;
    }
    if (painted?.block === block && rangesStillAround(painted.ranges, root, block)) return;
    const ranges = rangesAround(root, block);
    highlight.clear();
    ranges.forEach((range) => highlight.add(range));
    painted = { block, ranges };
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(paint);
  };
  const bind = (next: Editor | null) => {
    if (next === editor) return;
    editor?.off('transaction', schedule);
    editor = next;
    editor?.on('transaction', schedule);
    schedule();
  };

  bind(getActiveEditor());
  const unsubscribe = subscribeActiveEditor(bind);
  return () => {
    unsubscribe();
    editor?.off('transaction', schedule);
    editor = null;
    if (frame) cancelAnimationFrame(frame);
    CSS.highlights.delete(IMMERSIVE_DIM_HIGHLIGHT);
  };
}
