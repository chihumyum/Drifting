export interface MobileVisualViewportGeometry {
  height: number;
  offsetTop: number;
}

/**
 * Distance from the visual viewport's bottom edge to the layout viewport's
 * bottom edge. When a software keyboard overlays the WebView this is the
 * offset a fixed accessory needs in order to sit immediately above it.
 */
export function mobileKeyboardInset(
  layoutViewportHeight: number,
  visualViewport: MobileVisualViewportGeometry | null,
): number {
  if (!visualViewport) return 0;
  if (
    !Number.isFinite(layoutViewportHeight) ||
    !Number.isFinite(visualViewport.height) ||
    !Number.isFinite(visualViewport.offsetTop)
  ) {
    return 0;
  }
  return Math.max(
    0,
    layoutViewportHeight - Math.max(0, visualViewport.height) - visualViewport.offsetTop,
  );
}

export function readMobileKeyboardInset(): number {
  const viewport = window.visualViewport;
  if (!viewport) return 0;
  const layoutHeight = Math.max(window.innerHeight, document.documentElement.clientHeight);
  return mobileKeyboardInset(layoutHeight, {
    height: viewport.height,
    offsetTop: viewport.offsetTop,
  });
}
