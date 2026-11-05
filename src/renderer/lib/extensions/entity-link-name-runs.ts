import { Mark, type MarkType, type Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';

// Where the auto-linker looks for registered names.
//
// A name is read within a stretch of a textblock whose formatting is the same
// apart from entity links: bold or italic still splits a name, a link boundary
// does not. Edits can leave a name's characters split between link and plain
// text (a Markdown file edit that respelled 安娜蒂 as 安纳蒂 before 安纳蒂 was an
// alias left 安 and 蒂 linked and 纳 plain). Such a name is partly linked to
// its target, and linking it with that same link makes it one link again.

/** A stretch of a textblock's text whose formatting differs only in entity links. */
export interface NameRun {
  /** Document position of the stretch's first character. */
  from: number;
  text: string;
}

interface LinkTarget {
  kind: string;
  id: string;
}

function sameFormattingApartFromLinks(a: readonly Mark[], b: readonly Mark[], linkType: MarkType): boolean {
  return Mark.sameSet(
    a.filter((mark) => mark.type !== linkType),
    b.filter((mark) => mark.type !== linkType),
  );
}

export function forEachNameRun(doc: PMNode, linkType: MarkType, visit: (run: NameRun) => void): void {
  doc.descendants((node, pos) => {
    if (!node.inlineContent) return true;
    let run: NameRun | null = null;
    let runMarks: readonly Mark[] = [];
    let position = pos + 1;
    for (let index = 0; index < node.childCount; index++) {
      const child = node.child(index);
      if (child.isText && child.text) {
        if (run && sameFormattingApartFromLinks(runMarks, child.marks, linkType)) {
          run.text += child.text;
        } else {
          if (run) visit(run);
          run = { from: position, text: child.text };
          runMarks = child.marks;
        }
      } else if (run) {
        visit(run);
        run = null;
      }
      position += child.nodeSize;
    }
    if (run) visit(run);
    return false;
  });
}

/**
 * How [from, to) of `doc` is linked to `target`: whether every character is,
 * and one of the marks that does it.
 */
export function linkToTarget(
  doc: PMNode,
  from: number,
  to: number,
  linkType: MarkType,
  target: LinkTarget,
): { whole: boolean; mark: Mark | null } {
  let whole = true;
  let mark: Mark | null = null;
  doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return true;
    const link = node.marks.find(
      (candidate) =>
        candidate.type === linkType &&
        candidate.attrs.targetKind === target.kind &&
        candidate.attrs.targetId === target.id,
    );
    if (link) mark ??= link;
    else whole = false;
    return false;
  });
  return { whole, mark };
}

/**
 * Adds to `tr` a link on every registered name in its document that is not
 * already wholly linked to its target. `matcher` is a global alternation of
 * the names in `targets`, longest first. Returns whether it added any.
 */
export function linkRegisteredNames(
  tr: Transaction,
  linkType: MarkType,
  matcher: RegExp,
  targets: ReadonlyMap<string, LinkTarget>,
): boolean {
  const doc = tr.doc;
  let modified = false;
  forEachNameRun(doc, linkType, (run) => {
    matcher.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(run.text)) !== null) {
      const name = match[0];
      const target = targets.get(name);
      if (!target) continue;
      const from = run.from + match.index;
      const to = from + name.length;
      const existing = linkToTarget(doc, from, to, linkType, target);
      if (existing.whole) continue;
      tr.addMark(
        from,
        to,
        existing.mark ?? linkType.create({ targetKind: target.kind, targetId: target.id, targetBlockId: null }),
      );
      modified = true;
    }
  });
  return modified;
}
