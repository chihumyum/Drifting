/**
 * 打字时自动沉浸 (docs/editor/immersive-writing.md): with the setting on,
 * the author's first written text in the paper begins immersive writing,
 * and a sitting begun that way ends on a press off the text.
 */

/**
 * Native insertions that are not the author typing: pasting, dropping, the
 * system swapping a word, a link. A composition counts once, at its commit
 * (`compositionend`), never while it is being composed, so the sidebars do
 * not slide away under the pinyin.
 */
const NOT_TYPING = new Set([
  'insertFromPaste',
  'insertFromPasteAsQuotation',
  'insertFromDrop',
  'insertFromYank',
  'insertReplacementText',
  'insertLink',
  'insertCompositionText',
  'insertFromComposition',
]);

/** Whether an `input` event is the author writing text. A plain `Event` named input has no type. */
export function isTypingInput(event: Partial<Pick<InputEvent, 'inputType' | 'isComposing'>>): boolean {
  const type = event.inputType;
  return !event.isComposing && typeof type === 'string' && type.startsWith('insert') && !NOT_TYPING.has(type);
}

/**
 * Enter (and Shift+Enter) starts a paragraph or a line: writing too.
 * ProseMirror takes it on keydown, so no `input` event follows. The keydown
 * that commits a composition (`keyCode` 229 in WebKit) is the composition's.
 */
export function isTypingKey(
  event: Pick<KeyboardEvent, 'key' | 'keyCode' | 'isComposing' | 'metaKey' | 'ctrlKey' | 'altKey'>,
): boolean {
  return event.key === 'Enter' && !event.isComposing && event.keyCode !== 229
    && !event.metaKey && !event.ctrlKey && !event.altKey;
}

/** The text, and the way out (which leaves by itself), are not "elsewhere". */
export const IMMERSIVE_STAY_SELECTOR = '.ProseMirror, .immersive-writing-control--stage';

/**
 * Whether a press ends a sitting typing began: inside the workspace but off
 * the text. Cards, menus and dialogs portaled to `body` are not the
 * workspace, so a press there keeps the sitting.
 */
export function isPressElsewhere(
  target: Pick<Element, 'closest'> | null,
  root: Pick<Element, 'contains'>,
): boolean {
  if (!target || !root.contains(target as Element)) return false;
  return !target.closest(IMMERSIVE_STAY_SELECTOR);
}
