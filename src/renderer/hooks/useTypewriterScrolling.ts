import { useLayoutEffect, useMemo } from 'react';
import type { Editor } from '@tiptap/core';
import { useSettingsStore } from '../store/settings-store';
import { TypewriterScrollController, type TypewriterPresentation } from '../features/editor/typewriter-scroll';

export {
  createCaretRepaintCompensation, nextTypewriterScrollTop,
  normalizeTypewriterPosition, typewriterTailSpace,
} from '../features/editor/typewriter-scroll';

/** Only primary prose surfaces opt in; embedded cards never own page scroll. */
export function useTypewriterScrolling(
  editor: Editor | null,
  eligible: boolean,
  presentation: TypewriterPresentation,
): void {
  const enabled = useSettingsStore((state) => state.typewriterMode);
  const position = useSettingsStore((state) => state.typewriterPosition);
  const controller = useMemo(() => editor && eligible && enabled
    ? new TypewriterScrollController(editor) : null, [editor, eligible, enabled]);
  const { isVisible, isPreparing } = presentation;

  // Retain the owner and its visual tail across hide/show. Prepare dimensions
  // in layout before the stage reveals the incoming surface, without focusing
  // it or changing selection. Pixel visibility is independent of command focus.
  useLayoutEffect(() => controller?.attach(), [controller]);
  useLayoutEffect(() => {
    controller?.setPresentation({ isVisible, isPreparing }, position);
  }, [controller, isVisible, isPreparing, position]);
}
