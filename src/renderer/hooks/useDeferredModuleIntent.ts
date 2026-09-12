import { useEffect, useMemo } from 'react';
import type { FocusEvent, PointerEvent } from 'react';
import { deferredPreloader, type PreloadResource } from '../lib/deferred-preloader';

function createIntent(resource: PreloadResource | undefined) {
  let pointer = false;
  let focused = false;
  let cancel: (() => void) | null = null;
  const update = () => {
    if (resource && (pointer || focused)) {
      cancel ??= deferredPreloader.request(resource);
    } else {
      cancel?.();
      cancel = null;
    }
  };
  const releasePointer = () => { pointer = false; update(); };
  return {
    dispose() { pointer = false; focused = false; update(); },
    handlers: {
      onPointerEnter(event: PointerEvent<HTMLElement>) {
        if (event.pointerType === 'mouse' || event.pointerType === 'pen') { pointer = true; update(); }
      },
      onPointerLeave: releasePointer,
      onPointerDown(event: PointerEvent<HTMLElement>) {
        if (event.pointerType === 'touch') { pointer = true; update(); }
      },
      onPointerUp(event: PointerEvent<HTMLElement>) { if (event.pointerType === 'touch') releasePointer(); },
      onPointerCancel: releasePointer,
      onFocus() { focused = true; update(); },
      onBlur(event: FocusEvent<HTMLElement>) {
        if (!event.currentTarget.contains(event.relatedTarget)) { focused = false; update(); }
      },
    },
  };
}

/** Intent belongs to the mounted entry control, never to a project or editor. */
export function useDeferredModuleIntent(resource: PreloadResource | undefined) {
  const intent = useMemo(() => createIntent(resource), [resource]);
  useEffect(() => {
    if (!resource) return undefined;
    const onVisibility = () => { if (document.visibilityState !== 'visible') intent.dispose(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', intent.dispose);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', intent.dispose);
      intent.dispose();
    };
  }, [intent, resource]);
  return intent.handlers;
}
