// One-shot "focus this chapter's title when its editor is ready" intent. A
// chapter created from the ⁂ insert opens with its placeholder title selected
// so the author can name it straight away; the editor that mounts it (the
// single-chapter tab, or the promoted 通览全书 row) consumes the intent once.
const pendingTitleFocus = new Set<string>();

export function requestChapterTitleFocus(nodeId: string): void {
  pendingTitleFocus.add(nodeId);
}

export function consumeChapterTitleFocus(nodeId: string): boolean {
  return pendingTitleFocus.delete(nodeId);
}
