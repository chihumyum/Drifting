import { useEffect, useId } from 'react';
import { useHoverPreview } from '../entities/hover/entity-hover-card-model';

/**
 * Hover state for a review or TODO card's source card. Leaving waits a moment
 * so the pointer can reach the card's actions (`card` goes on the card);
 * pressing, typing or editing puts it away at once (`dismiss`); the card's
 * ⋯ button shows it at once (`open`).
 */
export function useCommentSourceHover(enabled: boolean) {
  const id = useId();
  const { preview, onEnter, onLeave, dismiss, open, card } = useHoverPreview<null>();
  useEffect(() => { if (!enabled) dismiss(); }, [enabled, dismiss]);
  useEffect(() => {
    if (!preview) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [preview, dismiss]);
  return {
    id,
    anchor: enabled ? preview?.anchor : undefined,
    onEnter: (anchor: HTMLElement) => { if (enabled) onEnter(null, anchor); },
    onLeave,
    dismiss,
    open: (anchor: HTMLElement) => { if (enabled) open(null, anchor); },
    card,
  };
}
