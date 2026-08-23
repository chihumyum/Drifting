import type { PlatformTarget } from './contracts';

export type UiShellMode = 'mobile' | 'desktop';
export type DeviceClass = 'desktop' | 'compact' | 'expanded';

/**
 * Portrait logical width at which a native tablet has enough room to reuse the
 * desktop information architecture. iPad mini remains below this boundary;
 * the 12.9/13-inch iPad family reaches 1024 CSS px in portrait.
 */
export const EXPANDED_TABLET_MIN_PORTRAIT_CSS_PX = 1000;

export interface UiShellResolution {
  deviceClass: DeviceClass;
  shellMode: UiShellMode;
}

interface ResolveUiShellOptions {
  target: PlatformTarget | 'unknown';
  screenWidth: number;
  screenHeight: number;
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * Resolve the presentation shell once, before React mounts. Native capability
 * ownership remains keyed to PlatformTarget; this result only chooses the UI
 * information architecture. Using the shortest screen edge makes the decision
 * stable even if the OS reports a stale landscape geometry during startup.
 */
export function resolveUiShellMode({
  target,
  screenWidth,
  screenHeight,
}: ResolveUiShellOptions): UiShellResolution {
  if (target !== 'mobile') {
    return { deviceClass: 'desktop', shellMode: 'desktop' };
  }

  if (!isPositiveFinite(screenWidth) || !isPositiveFinite(screenHeight)) {
    return { deviceClass: 'compact', shellMode: 'mobile' };
  }

  const portraitLogicalWidth = Math.min(screenWidth, screenHeight);
  if (portraitLogicalWidth >= EXPANDED_TABLET_MIN_PORTRAIT_CSS_PX) {
    return { deviceClass: 'expanded', shellMode: 'desktop' };
  }

  return { deviceClass: 'compact', shellMode: 'mobile' };
}
