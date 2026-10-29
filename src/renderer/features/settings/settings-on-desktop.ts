import { getPlatformRuntime } from '../../platform/runtime';

/** The desktop settings are built from the shared controls in
 * docs/design-system/components.md. The paused mobile shell renders the same
 * panels and keeps the older `set-*` controls, so each place that draws a
 * control asks once which one to draw. */
export function settingsOnDesktop(): boolean {
  return !getPlatformRuntime().isMobileShell;
}
