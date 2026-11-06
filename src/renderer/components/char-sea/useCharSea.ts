import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { charSeaSupported } from '../../lib/char-sea/char-sea';
import { charSeaRegistry, type CharSeaHoldKind, type CharSeaShapeOptions } from '../../lib/char-sea/char-sea-registry';

/**
 * Whether the sea of characters lies under this window: wherever WebGL2 is
 * there. Pages ask before dropping their own ground, rims or spinner.
 */
export function charSeaEnabled(): boolean {
  if (typeof document === 'undefined') return false;
  return charSeaSupported();
}

export function useCharSeaEnabled(): boolean {
  const [enabled] = useState(charSeaEnabled);
  return enabled;
}

/**
 * Holds the sea on while mounted: as a full-window wait, as a first run's
 * name, as the page lying on it, or as a page lying on it in the rain. Taken before paint, so the first
 * frame of the page already lies on the sea (an effect would let one frame of
 * the bare body through).
 */
export function useCharSeaHold(kind: CharSeaHoldKind, on: boolean): void {
  useLayoutEffect(() => (on ? charSeaRegistry.hold(kind) : undefined), [kind, on]);
}

/**
 * Registers an element as glass the sea draws, so its rim can feel the water.
 * Pass `attach` as the element's ref. `drawn` says whether the sea draws it
 * (the element drops its own CSS rim); the hover props bring the glass's
 * bleed and drift under the pointer or focus. `arrive` sets it down with no
 * resting line at first; `waiting` keeps its rim flowing until it is cleared.
 */
export function useCharSeaShape<T extends HTMLElement>(
  options: CharSeaShapeOptions & { hover?: boolean; waiting?: boolean },
) {
  const drawn = useCharSeaEnabled();
  const [element, setElement] = useState<T | null>(null);
  const { rest, radius, arrive = false, waiting = false } = options;
  // What the glass is now, for a registration that comes later (the element mounts after).
  const now = useRef({ rest, waiting });
  useLayoutEffect(() => {
    now.current = { rest, waiting };
  }, [rest, waiting]);

  useEffect(() => {
    if (!drawn || !element) return undefined;
    const remove = charSeaRegistry.addShape(element, { rest: now.current.rest, radius, arrive }, now.current.waiting);
    // Glass whose content changes (a card that steps through a flow) moves its rim with it.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => charSeaRegistry.resized());
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      remove();
    };
  }, [drawn, element, radius, arrive]);

  // A line that changes strength, or glass that starts or stops waiting, changes in place.
  useEffect(() => {
    if (drawn && element) charSeaRegistry.update(element, { rest, waiting });
  }, [drawn, element, rest, waiting]);

  const on = useCallback(() => { if (element) charSeaRegistry.hover(element, true); }, [element]);
  const off = useCallback(() => { if (element) charSeaRegistry.hover(element, false); }, [element]);
  const hoverProps = options.hover === false
    ? {}
    : { onPointerEnter: on, onPointerLeave: off, onFocus: on, onBlur: off };

  return { attach: setElement, drawn, hoverProps };
}
