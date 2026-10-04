import type { Mark, MarkType } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

// Input-method composition at the end of an entity link.
//
// `entityLink` is `inclusive: false`, so ProseMirror starts a composition right
// after a link in its "mark cursor" path: a cursor-wrapper widget makes the
// browser compose in a separate text node outside the link. When plain text
// follows the link, ProseMirror's model merges the composed text with it, and
// on every marked-text update its composition protection rewrites that sibling
// node inside WebKit's `input` dispatch. WebKit then loses its composition and
// leaves the marked text selected (see
// docs/renderer-performance/editor-ime-copilot.md).
//
// Instead, for one composition the link counts as inclusive: ProseMirror takes
// its ordinary path, WebKit composes inside the link's own text node, and the
// view and model agree. Once the composition ends, the characters typed past the
// link's original text leave the link again, so the document is the same as
// before this workaround.

export const EntityLinkCompositionPluginKey = new PluginKey('entityLinkComposition');

/** Transaction meta for the post-composition strip. */
export const ENTITY_LINK_COMPOSITION_META = 'entityLinkComposition';

export interface LinkEndComposition {
  /** The link mark ending at the caret. */
  mark: Mark;
  /** Text of the contiguous run carrying `mark` that ends at the caret. */
  linkText: string;
  /** Whether the caret was at the link's end (not between two parts of it). */
  strip: boolean;
}

/**
 * The link composition a collapsed caret would start, or null when ProseMirror
 * would not use its cursor wrapper for `markType` here.
 */
export function linkEndCompositionAt(state: EditorState, markType: MarkType): LinkEndComposition | null {
  const { selection, storedMarks } = state;
  // Stored marks send ProseMirror down the cursor-wrapper path regardless.
  if (!(selection instanceof TextSelection) || !selection.empty || storedMarks) return null;
  const $pos = selection.$to;
  if ($pos.textOffset !== 0 || $pos.parentOffset === 0) return null;
  const before = $pos.nodeBefore;
  if (!before?.isText) return null;
  const mark = before.marks.find((candidate) => candidate.type === markType);
  if (!mark) return null;
  // Another non-inclusive mark would still require the cursor wrapper.
  if (before.marks.some((candidate) => candidate.type !== markType && candidate.type.spec.inclusive === false)) {
    return null;
  }
  let linkText = '';
  for (let index = $pos.index() - 1; index >= 0; index--) {
    const child = $pos.parent.child(index);
    if (!child.isText || !mark.isInSet(child.marks)) break;
    linkText = child.text + linkText;
  }
  const after = $pos.nodeAfter;
  return { mark, linkText, strip: !(after && mark.isInSet(after.marks)) };
}

/**
 * Removes `composition.mark` from text composed past the link's original text,
 * found as the run around the caret. Null when there is nothing to move.
 */
export function stripLinkEndComposition(state: EditorState, composition: LinkEndComposition): Transaction | null {
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
        if (runText.length <= composition.linkText.length || !runText.startsWith(composition.linkText)) return null;
        const from = parentStart + runStart + composition.linkText.length;
        return state.tr
          .removeMark(from, parentStart + runEnd, composition.mark)
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
  let active: LinkEndComposition | null = null;
  let stripTimer: ReturnType<typeof setTimeout> | null = null;
  overrideMarkInclusive(markType, () => active !== null);

  const finish = (view: EditorView) => {
    if (stripTimer) clearTimeout(stripTimer);
    stripTimer = null;
    const composition = active;
    active = null;
    if (!composition || view.isDestroyed) return;
    const tr = stripLinkEndComposition(view.state, composition);
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
          const composition = linkEndCompositionAt(view.state, markType);
          if (!composition) return false;
          active = composition;
          // Compose in the link's own text node, where the model now places it.
          const { node, offset } = view.domAtPos(view.state.selection.from, -1);
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
