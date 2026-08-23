export interface MobileVisualViewportGeometry {
  height: number;
  offsetTop: number;
}

export const MOBILE_NATIVE_KEYBOARD_GEOMETRY_EVENT = 'drifting:native-keyboard-geometry';

export function mobileNativeKeyboardInset(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function readMobileNativeKeyboardInset(): number {
  if (typeof document === 'undefined') return 0;
  return mobileNativeKeyboardInset(
    document.documentElement.style.getPropertyValue('--mobile-native-keyboard-inset'),
  );
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

/**
 * A panned visual viewport can have no remaining bottom inset while the
 * software keyboard is still visible. Visibility therefore follows the
 * viewport height reduction and deliberately ignores offsetTop.
 */
export function mobileSoftwareKeyboardVisible(
  layoutViewportHeight: number,
  visualViewport: MobileVisualViewportGeometry | null,
  threshold = 72,
): boolean {
  if (!visualViewport) return false;
  if (
    !Number.isFinite(layoutViewportHeight) ||
    !Number.isFinite(visualViewport.height) ||
    !Number.isFinite(threshold)
  ) {
    return false;
  }
  return layoutViewportHeight - Math.max(0, visualViewport.height) >= Math.max(0, threshold);
}

function readMobileVisualViewportGeometry(): {
  layoutHeight: number;
  viewport: MobileVisualViewportGeometry;
} | null {
  const viewport = window.visualViewport;
  if (!viewport) return null;
  // WKWebView may shrink window.innerHeight and documentElement.clientHeight
  // after an ordinary input takes focus, while the fixed application body
  // retains the pre-keyboard layout viewport height.
  const bodyHeight = document.body?.getBoundingClientRect().height ?? 0;
  return {
    layoutHeight: Math.max(
      window.innerHeight,
      document.documentElement.clientHeight,
      document.documentElement.getBoundingClientRect().height,
      bodyHeight,
    ),
    viewport: {
      height: viewport.height,
      offsetTop: viewport.offsetTop,
    },
  };
}

export function readMobileKeyboardInset(): number {
  const geometry = readMobileVisualViewportGeometry();
  const visualInset = geometry
    ? mobileKeyboardInset(geometry.layoutHeight, geometry.viewport)
    : 0;
  return Math.max(visualInset, readMobileNativeKeyboardInset());
}

export function readMobileSoftwareKeyboardVisible(threshold = 72): boolean {
  if (readMobileNativeKeyboardInset() >= Math.max(0, threshold)) return true;
  const geometry = readMobileVisualViewportGeometry();
  if (!geometry) return false;
  return mobileSoftwareKeyboardVisible(geometry.layoutHeight, geometry.viewport, threshold);
}
