import type { Mark, MarkType } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

// Input-method composition at the edge of an entity link.
//
// At a link's end: `entityLink` is `inclusive: false`, so ProseMirror starts a
// composition right after a link in its "mark cursor" path: a cursor-wrapper
// widget makes the browser compose in a separate text node outside the link.
// When plain text follows the link, ProseMirror's model merges the composed
// text with it, and on every marked-text update its composition protection
// rewrites that sibling node inside WebKit's `input` dispatch. WebKit then loses
// its composition and leaves the marked text selected (see
// docs/renderer-performance/editor-ime-copilot.md).
//
// At a link's start with no text before it on the line (a textblock start or
// after a hard break), WebKit has no position before the link's element and
// composes inside it, and ProseMirror reads the composed text into the link.
//
// In both cases the link counts as inclusive for that one composition:
// ProseMirror takes its ordinary path, WebKit composes inside the link's own
// text node, and the view and model agree. Once the composition ends, the
// characters typed beyond the link's original text leave the link again, so the
// document is the same as typing outside it.

export const EntityLinkCompositionPluginKey = new PluginKey('entityLinkComposition');

/** Transaction meta for the post-composition strip. */
export const ENTITY_LINK_COMPOSITION_META = 'entityLinkComposition';

export interface LinkComposition {
  /** The link mark at the caret. */
  mark: Mark;
  /** Which edge of the link the caret is at. */
  side: 'start' | 'end';
  /** Text of the contiguous run carrying `mark` that starts or ends at the caret. */
  linkText: string;
  /** False when the caret sits between two parts of one link. */
  strip: boolean;
}

/**
 * The link composition a collapsed caret would start, or null when the caret
 * is not at an edge of a `markType` link where the browser or ProseMirror would
 * compose outside the link's text node.
 */
export function linkCompositionAt(state: EditorState, markType: MarkType): LinkComposition | null {
  const { selection, storedMarks } = state;
  // Stored marks send ProseMirror down the cursor-wrapper path regardless.
  if (!(selection instanceof TextSelection) || !selection.empty || storedMarks) return null;
  const $pos = selection.$to;
  if ($pos.textOffset !== 0) return null;
  const { nodeBefore: before, nodeAfter: after, parent } = $pos;
  const run = (mark: Mark, step: -1 | 1) => {
    let text = '';
    for (let index = $pos.index() + (step < 0 ? -1 : 0); index >= 0 && index < parent.childCount; index += step) {
      const child = parent.child(index);
      if (!child.isText || !mark.isInSet(child.marks)) break;
      text = step < 0 ? child.text + text : text + child.text;
    }
    return text;
  };
  const endMark = before?.isText ? before.marks.find((candidate) => candidate.type === markType) : undefined;
  if (endMark) {
    // Another non-inclusive mark would still require the cursor wrapper.
    if (before!.marks.some((candidate) => candidate.type !== markType && candidate.type.spec.inclusive === false)) {
      return null;
    }
    return { mark: endMark, side: 'end', linkText: run(endMark, -1), strip: !(after && endMark.isInSet(after.marks)) };
  }
  // With text before the caret, WebKit composes at that text's end instead.
  const startMark = !before?.isText && after?.isText ? after.marks.find((candidate) => candidate.type === markType) : undefined;
  if (startMark) return { mark: startMark, side: 'start', linkText: run(startMark, 1), strip: true };
  return null;
}

/**
 * Removes `composition.mark` from text composed beyond the link's original
 * text, found as the run around the caret. Null when there is nothing to move.
 */
export function stripLinkComposition(state: EditorState, composition: LinkComposition): Transaction | null {
  if (!composition.strip) return null;
  const $head = state.selection.$head;
  const parent = $head.parent;
  if (!parent.inlineContent) return null;
  const parentStart = $head.start();
  const caret = $head.parentOffset;
  let runStart = -1;
  let runText = '';
  let offset = 0;
  for (let index = 0; index < parent.childCount; index++) {
    const child = parent.child(index);
    const inRun = child.isText && composition.mark.isInSet(child.marks);
    if (inRun) {
      if (runStart < 0) {
        runStart = offset;
        runText = '';
      }
      runText += child.text;
    }
    offset += child.nodeSize;
    const runEnds = !inRun || index === parent.childCount - 1;
    if (runStart >= 0 && runEnds) {
      const runEnd = inRun ? offset : offset - child.nodeSize;
      if (runStart <= caret && caret <= runEnd) {
        const { linkText, side } = composition;
        const kept = side === 'end' ? runText.startsWith(linkText) : runText.endsWith(linkText);
        if (runText.length <= linkText.length || !kept) return null;
        const [from, to] = side === 'end'
          ? [runStart + linkText.length, runEnd]
          : [runStart, runEnd - linkText.length];
        return state.tr
          .removeMark(parentStart + from, parentStart + to, composition.mark)
          .setMeta(ENTITY_LINK_COMPOSITION_META, true);
      }
      runStart = -1;
    }
  }
  return null;
}

/**
 * Makes `markType` inclusive while `isInclusive()` holds. ProseMirror reads
 * `spec.inclusive` at use sites, and each editor builds its own schema.
 */
export function overrideMarkInclusive(markType: MarkType, isInclusive: () => boolean): void {
  const declared = markType.spec.inclusive;
  Object.defineProperty(markType.spec, 'inclusive', {
    configurable: true,
    enumerable: true,
    get: () => (isInclusive() ? true : declared),
  });
}

/** ProseMirror's own Safari test: WebKit on macOS and iOS. */
export function isAppleWebKit(): boolean {
  return typeof navigator !== 'undefined' && /Apple Computer/.test(navigator.vendor);
}

export function createEntityLinkCompositionPlugin(markType: MarkType): Plugin {
  let active: LinkComposition | null = null;
  let stripTimer: ReturnType<typeof setTimeout> | null = null;
  overrideMarkInclusive(markType, () => active !== null);

  const finish = (view: EditorView) => {
    if (stripTimer) clearTimeout(stripTimer);
    stripTimer = null;
    const composition = active;
    active = null;
    if (!composition || view.isDestroyed) return;
    const tr = stripLinkComposition(view.state, composition);
    if (tr) view.dispatch(tr);
  };

  // ProseMirror ends a composition after `compositionend` and flushes pending
  // DOM changes in a microtask; strip after both, unless another started.
  const scheduleFinish = (view: EditorView) => {
    if (stripTimer) clearTimeout(stripTimer);
    stripTimer = setTimeout(() => {
      stripTimer = null;
      if (!view.composing) finish(view);
    }, 0);
  };

  return new Plugin({
    key: EntityLinkCompositionPluginKey,
    view: () => ({
      update(view) {
        // A composition can end without `compositionend` reaching this editor
        // (focus moved away); the link must not stay inclusive for typing.
        if (active && !stripTimer && !view.composing) scheduleFinish(view);
      },
      destroy() {
        if (stripTimer) clearTimeout(stripTimer);
        stripTimer = null;
        active = null;
      },
    }),
    props: {
      handleDOMEvents: {
        // Runs before ProseMirror's own compositionstart handler, which decides
        // on the cursor wrapper from `spec.inclusive`.
        compositionstart(view) {
          if (view.composing) return false;
          // A composition that begins before the previous strip ran (fast
          // typing) must not inherit the extended link.
          if (active) finish(view);
          const composition = linkCompositionAt(view.state, markType);
          if (!composition) return false;
          active = composition;
          // Compose in the link's own text node, where the model now places it.
          const { node, offset } = view.domAtPos(view.state.selection.from, composition.side === 'end' ? -1 : 1);
          const selection = view.dom.ownerDocument.getSelection();
          if (node.nodeType === Node.TEXT_NODE && selection &&
              (selection.focusNode !== node || selection.focusOffset !== offset || !selection.isCollapsed)) {
            selection.collapse(node, offset);
          }
          return false;
        },
        compositionend(view) {
          if (active) scheduleFinish(view);
          return false;
        },
      },
    },
  });
}
