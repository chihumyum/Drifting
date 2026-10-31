import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { charSeaSupported } from '../../lib/char-sea/char-sea';
import { charSeaRegistry, type CharSeaShapeOptions } from '../../lib/char-sea/char-sea-registry';
import { getPlatformRuntime } from '../../platform/runtime';

/**
 * Whether the sea of characters lies under this window: the desktop shell,
 * where WebGL2 is there. The paused mobile shell keeps its own surfaces.
 * Pages ask before dropping their own ground, rims or spinner.
 */
export function charSeaEnabled(): boolean {
  if (typeof document === 'undefined') return false;
  return !getPlatformRuntime().isMobileShell && charSeaSupported();
}

export function useCharSeaEnabled(): boolean {
  const [enabled] = useState(charSeaEnabled);
  return enabled;
}

/**
 * Holds the sea on while mounted: as a full-window wait, or as the page lying
 * on it. Taken before paint, so the first frame of the page already lies on
 * the sea (an effect would let one frame of the bare body through).
 */
export function useCharSeaHold(kind: 'loading' | 'surface', on: boolean): void {
  useLayoutEffect(() => (on ? charSeaRegistry.hold(kind) : undefined), [kind, on]);
}

/**
 * Registers an element as glass the sea draws, so its rim can feel the water.
 * Pass `attach` as the element's ref. `drawn` says whether the sea draws it
 * (the element drops its own CSS rim); the hover props bring the glass's
 * bleed and drift under the pointer or focus.
 */
export function useCharSeaShape<T extends HTMLElement>(options: CharSeaShapeOptions & { hover?: boolean }) {
  const drawn = useCharSeaEnabled();
  const [element, setElement] = useState<T | null>(null);
  const { rest, radius } = options;

  useEffect(() => {
    if (!drawn || !element) return undefined;
    return charSeaRegistry.addShape(element, { rest, radius });
  }, [drawn, element, rest, radius]);

  const on = useCallback(() => { if (element) charSeaRegistry.hover(element, true); }, [element]);
  const off = useCallback(() => { if (element) charSeaRegistry.hover(element, false); }, [element]);
  const hoverProps = options.hover === false
    ? {}
    : { onPointerEnter: on, onPointerLeave: off, onFocus: on, onBlur: off };

  return { attach: setElement, drawn, hoverProps };
}
