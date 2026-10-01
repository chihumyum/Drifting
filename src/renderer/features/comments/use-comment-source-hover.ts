import { useEffect, useId } from 'react';
import { useHoverPreview } from '../entities/hover/entity-hover-card-model';

export function useCommentSourceHover(enabled: boolean) {
  const id = useId();
  const { preview, onEnter, onLeave } = useHoverPreview<null>();
  useEffect(() => { if (!enabled) onLeave(); }, [enabled, onLeave]);
  useEffect(() => {
    if (!preview) return;
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape') onLeave(); };
    document.addEventListener('keydown', dismiss);
    return () => document.removeEventListener('keydown', dismiss);
  }, [preview, onLeave]);
  return {
    id,
    anchor: enabled ? preview?.anchor : undefined,
    onEnter: (anchor: HTMLElement) => { if (enabled) onEnter(null, anchor); },
    onLeave,
  };
}
