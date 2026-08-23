import type { AppInfo, PlatformCapabilities, PlatformTarget } from './contracts';
import { platform } from './index';
import {
  resolveUiShellMode,
  type DeviceClass,
  type UiShellMode,
} from './ui-shell-mode';

export type RuntimeTarget = PlatformTarget | 'unknown';

export interface PlatformRuntimeSnapshot {
  appInfo: AppInfo | null;
  capabilities: PlatformCapabilities | null;
  target: RuntimeTarget;
  nativePlatform: string;
  deviceClass: DeviceClass;
  shellMode: UiShellMode;
  isMobile: boolean;
  isMobileShell: boolean;
  isExpandedTablet: boolean;
  isMacDesktop: boolean;
  desktopWindowControls: boolean;
}

const UNKNOWN_RUNTIME: PlatformRuntimeSnapshot = {
  appInfo: null,
  capabilities: null,
  target: 'unknown',
  nativePlatform: 'unknown',
  deviceClass: 'desktop',
  shellMode: 'desktop',
  isMobile: false,
  isMobileShell: false,
  isExpandedTablet: false,
  isMacDesktop: false,
  desktopWindowControls: false,
};

let snapshot = UNKNOWN_RUNTIME;
let hydration: Promise<PlatformRuntimeSnapshot> | null = null;

function publish(next: PlatformRuntimeSnapshot): PlatformRuntimeSnapshot {
  snapshot = next;
  document.documentElement.dataset.platformTarget = next.target;
  document.documentElement.dataset.nativePlatform = next.nativePlatform;
  document.documentElement.dataset.deviceClass = next.deviceClass;
  document.documentElement.dataset.shellMode = next.shellMode;
  return next;
}

/**
 * Resolve immutable native platform facts before React mounts. Shell code can
 * then branch on Tauri's advertised target/capabilities without UA guessing or
 * an initial mobile render that briefly exposes desktop window chrome.
 */
export function hydratePlatformRuntime(): Promise<PlatformRuntimeSnapshot> {
  if (hydration) return hydration;

  hydration = Promise.all([platform.app.getInfo(), platform.app.getCapabilities()])
    .then(([appInfo, capabilities]) => {
      const uiShell = resolveUiShellMode({
        target: capabilities.target,
        screenWidth: window.screen.width,
        screenHeight: window.screen.height,
      });
      return publish({
        appInfo,
        capabilities,
        target: capabilities.target,
        nativePlatform: appInfo.platform,
        ...uiShell,
        isMobile: capabilities.target === 'mobile',
        isMobileShell: uiShell.shellMode === 'mobile',
        isExpandedTablet: uiShell.deviceClass === 'expanded',
        isMacDesktop: capabilities.target === 'desktop' && appInfo.platform === 'macos',
        desktopWindowControls:
          capabilities.target === 'desktop' && capabilities.desktopWindowControls,
      });
    })
    .catch((error) => {
      // A plain Vite/browser render has no native shell. Keep rendering for
      // development, but advertise no window-control capability rather than
      // guessing from navigator fields.
      console.warn('[platform] native runtime metadata is unavailable:', error);
      return publish(UNKNOWN_RUNTIME);
    });

  return hydration;
}

export function getPlatformRuntime(): PlatformRuntimeSnapshot {
  return snapshot;
}
