import type { Editor } from '@tiptap/core';
import type { Mark } from '@tiptap/pm/model';
import type { EntityKind } from '../domain/entity-kinds';

/**
 * Walk the whole editor document and stamp the entityLink mark on every run of
 * text matching any of `target.names`, pointing at the given entity. Used to
 * retroactively link prose written BEFORE the entity existed — the autoDetect
 * plugin only fires on freshly-typed text, so earlier blocks would stay
 * unlinked otherwise.
 *
 * Verbatim case-sensitive matching, independently for each alias. Matches of
 * different aliases can overlap. A text run already linked to this target is
 * skipped, so re-running (or overlapping with autoDetect) is safe. Dispatched
 * with `addToHistory: false` so retro-linking isn't an undo step.
 */
export function linkEntityInDoc(
  editor: Editor,
  target: { kind: EntityKind; id: string; names: string[] },
): void {
  const markType = editor.schema.marks.entityLink;
  if (!markType) return;
  const names = Array.from(new Set(target.names.map((n) => n.trim()).filter(Boolean)));
  if (names.length === 0) return;

  const tr = editor.state.tr;
  let modified = false;
  let mark: Mark | undefined;

  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    // A PM text node is a single uniform mark run, so one check covers it all:
    // if it already links to this target, every match inside is already linked.
    const alreadyLinked = node.marks.some(
      (mark) =>
        mark.type === markType &&
        mark.attrs.targetKind === target.kind &&
        mark.attrs.targetId === target.id,
    );
    if (alreadyLinked) return;
    const text = node.text;
    for (const name of names) {
      // Literal UTF-16 matching preserves the previous escaped /g behavior:
      // each name advances by its own length; different aliases may overlap.
      for (let index = text.indexOf(name); index !== -1; index = text.indexOf(name, index + name.length)) {
        const from = pos + index;
        tr.addMark(
          from,
          from + name.length,
          mark ??= markType.create({ targetKind: target.kind, targetId: target.id, targetBlockId: null }),
        );
        modified = true;
      }
    }
  });

  if (!modified) return;
  tr.setMeta('addToHistory', false);
  editor.view.dispatch(tr);
}
