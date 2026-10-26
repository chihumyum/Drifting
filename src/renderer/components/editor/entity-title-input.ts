import type { KeyboardEvent } from 'react';

/** A title is one logical line: pasted or dropped newlines become spaces. */
export function stripTitleNewlines(value: string): string {
  return value.replace(/\r\n|[\r\n]/gu, ' ');
}

/** Enter that confirms an IME composition belongs to the IME, not the field. */
export function isComposingEnter(event: Pick<KeyboardEvent, 'key' | 'keyCode' | 'nativeEvent'>): boolean {
  return event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229);
}
