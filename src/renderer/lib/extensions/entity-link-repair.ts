import { isChangeOrigin } from '@tiptap/extension-collaboration';
import type { Mark, MarkType, Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import type { Mapping } from '@tiptap/pm/transform';

// An entity link whose name an edit breaks stops being a link.
//
// ProseMirror keeps a mark on whatever text remains of it, so deleting 格 from
// a linked 约格 left 约 linked. Every way Drifting creates entity links (the
// auto-linker, retroactive linking, the @-picker and agent writes) puts a name
// or alias of the target in the link, but older or pasted content may link
// arbitrary text. So a link is removed only when an author edit changed its
// text from a registered name or alias of its own target into text that is not
// one. Auto-linking may then link the remaining text again if it is another
// name.

export const EntityLinkRepairPluginKey = new PluginKey<EditedLinkRun[]>('entityLinkRepair');

/** Transaction meta for a repair; it also clears the pending runs. */
export const ENTITY_LINK_REPAIR_META = 'entityLinkRepair';

/** A link run an edit touched, positioned in the current document, with its text before the edit. */
export interface EditedLinkRun {
  from: number;
  to: number;
  mark: Mark;
  text: string;
}

/** Whether `text` is a registered name or alias of `mark`'s target. */
export type IsLinkName = (text: string, mark: Mark) => boolean;

interface Run {
  from: number;
  to: number;
  text: string;
}

/** The contiguous run carrying `mark` around child `index` of a textblock. */
function expandRun(parent: PMNode, parentStart: number, index: number, mark: Mark): Run {
  let first = index;
  let last = index;
  const inRun = (child: PMNode) => child.isText && mark.isInSet(child.marks);
  while (first > 0 && inRun(parent.child(first - 1))) first--;
  while (last < parent.childCount - 1 && inRun(parent.child(last + 1))) last++;
  let from = parentStart;
  for (let child = 0; child < first; child++) from += parent.child(child).nodeSize;
  let text = '';
  for (let child = first; child <= last; child++) text += parent.child(child).text;
  return { from, to: from + text.length, text };
}

/** Link runs of `markType` in `doc` that overlap or touch [from, to]. */
function linkRunsTouching(doc: PMNode, markType: MarkType, from: number, to: number): EditedLinkRun[] {
  const runs: EditedLinkRun[] = [];
  doc.nodesBetween(Math.max(0, from - 1), Math.min(doc.content.size, to + 1), (node, pos) => {
    if (!node.inlineContent) return true;
    const start = pos + 1;
    let offset = start;
    node.forEach((child, _offset, index) => {
      const childFrom = offset;
      offset += child.nodeSize;
      if (!child.isText || offset < from || childFrom > to) return;
      for (const mark of child.marks) {
        if (mark.type !== markType) continue;
        const run = expandRun(node, start, index, mark);
        if (!runs.some((seen) => seen.from === run.from && seen.mark.eq(mark))) runs.push({ ...run, mark });
      }
    });
    return false;
  });
  return runs;
}

/** Link runs touched by the steps of `tr`, mapped into its resulting document. */
export function collectEditedLinkRuns(tr: Transaction, markType: MarkType): EditedLinkRun[] {
  const runs: EditedLinkRun[] = [];
  tr.steps.forEach((step, index) => {
    const after = tr.mapping.slice(index);
    // Mark-only steps have an empty map and leave the text alone.
    step.getMap().forEach((oldStart, oldEnd) => {
      for (const run of linkRunsTouching(tr.docs[index], markType, oldStart, oldEnd)) {
        runs.push({ ...run, from: after.map(run.from, 1), to: after.map(run.to, -1) });
      }
    });
  });
  return runs;
}

export function mapEditedLinkRuns(runs: readonly EditedLinkRun[], mapping: Mapping): EditedLinkRun[] {
  return runs.map((run) => ({ ...run, from: mapping.map(run.from, 1), to: mapping.map(run.to, -1) }));
}

/** The run carrying `mark` that starts inside [from, to), if any. */
function linkRunWithin(doc: PMNode, mark: Mark, from: number, to: number): Run | null {
  let found: Run | null = null;
  doc.nodesBetween(from, to, (node, pos) => {
    if (found) return false;
    if (!node.isText || !mark.isInSet(node.marks)) return true;
    const $pos = doc.resolve(pos);
    found = expandRun($pos.parent, $pos.start(), $pos.index(), mark);
    return false;
  });
  return found;
}

/**
 * Adds to `tr` the removal of every edited link whose text changed from a name
 * of its target into a non-name. Returns whether anything was removed.
 */
export function repairEditedLinks(tr: Transaction, runs: readonly EditedLinkRun[], isName: IsLinkName): boolean {
  let modified = false;
  const repaired = new Set<string>();
  for (const run of runs) {
    if (run.from >= run.to || !isName(run.text, run.mark)) continue;
    const current = linkRunWithin(tr.doc, run.mark, run.from, run.to);
    if (!current || current.text === run.text || isName(current.text, run.mark)) continue;
    const key = `${current.from}:${current.to}:${run.mark.attrs.targetKind}:${run.mark.attrs.targetId}`;
    if (repaired.has(key)) continue;
    repaired.add(key);
    tr.removeMark(current.from, current.to, run.mark);
    modified = true;
  }
  return modified;
}

/**
 * Tracks link runs touched by author edits and repairs them with the next edit
 * made outside an input-method composition. Edits during a composition wait
 * (changing marks around marked text disturbs it); the debounced auto-link pass
 * also repairs them once the composition has ended.
 */
export function createEntityLinkRepairPlugin(markType: MarkType, isName: IsLinkName, metaToIgnore: string[] = []): Plugin {
  return new Plugin<EditedLinkRun[]>({
    key: EntityLinkRepairPluginKey,
    state: {
      init: () => [],
      apply(tr, runs) {
        if (tr.getMeta(ENTITY_LINK_REPAIR_META)) return [];
        if (!tr.docChanged) return runs;
        const mapped = mapEditedLinkRuns(runs, tr.mapping);
        // Remote Yjs changes (including undo) and link maintenance are not author edits.
        if (isChangeOrigin(tr) || metaToIgnore.some((meta) => tr.getMeta(meta))) return mapped;
        // Keep only names this edit changed, so typing beside a link adds no work.
        const broken = collectEditedLinkRuns(tr, markType).filter((run) => {
          if (run.from >= run.to || !isName(run.text, run.mark)) return false;
          const current = linkRunWithin(tr.doc, run.mark, run.from, run.to);
          return current !== null && current.text !== run.text;
        });
        return broken.length ? mapped.concat(broken) : mapped;
      },
    },
    appendTransaction(transactions, _oldState, state) {
      const runs = EntityLinkRepairPluginKey.getState(state);
      if (!runs?.length) return null;
      if (transactions.some((tr) => tr.getMeta('composition') !== undefined)) return null;
      if (!transactions.some((tr) => tr.docChanged && !isChangeOrigin(tr))) return null;
      const tr = state.tr.setMeta(ENTITY_LINK_REPAIR_META, true);
      repairEditedLinks(tr, runs, isName);
      return tr;
    },
  });
}

export function pendingEditedLinkRuns(state: EditorState): EditedLinkRun[] {
  return EntityLinkRepairPluginKey.getState(state) ?? [];
}
