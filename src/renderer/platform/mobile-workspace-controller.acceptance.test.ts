import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(rendererRoot, '../..');
const source = (path: string) => readFileSync(resolve(rendererRoot, path), 'utf8');

describe('mobile desk controller architecture', () => {
  it('keeps the desk in one reducer-owned state', () => {
    const desk = source('shells/mobile/desk/MobileDesk.tsx');
    expect(desk).toContain('useReducer(mobileDeskReducer');
    expect(desk).not.toContain('setOverviewOpen');
    expect(desk).not.toContain('setTrashOpen');
    const controller = source('shells/mobile/desk/mobile-desk-controller.ts');
    for (const axis of ['stage:', 'drawer:', 'bottom:', 'superView:', 'sheet:', 'popover:', 'writing:', 'keyboardBar:']) {
      expect(controller).toContain(axis);
    }
    expect(controller).toContain('export function resolveMobileDeskBack');
  });

  it('routes visible, Escape, Super View, and Android hardware Back through one request', () => {
    const hook = source('shells/mobile/desk/useMobileDeskBack.ts');
    const androidBack = source('shells/mobile/useMobileAndroidBack.ts');
    const superStack = source('hooks/useSuperViewEscapeStack.ts');
    const superHeader = source('components/SuperViewHeader.tsx');
    const host = source('shells/mobile/workspace/MobileSuperViewHost.tsx');
    expect(androidBack).toContain('androidBackRegistration = onBackButtonPress(() =>');
    expect(androidBack).toContain('const androidBackConsumers = new Set<() => void>()');
    expect(androidBack).toContain("an unregister failure must not become an unhandled rejection");
    expect(hook).toContain("useMobileAndroidBack(() => requestMobileWorkspaceBack('android-hardware'))");
    expect(hook).toContain('resolveMobileDeskBack');
    expect(superStack).toContain('MOBILE_WORKSPACE_BACK_EVENT');
    expect(superHeader).toContain("requestMobileWorkspaceBack('visible')");
    // A pan from the left edge takes a Super View back the way Back does.
    expect(host).toContain("requestMobileWorkspaceBack('visible')");
  });

  it('relies on Tauri AppPlugin hardware Back while native JS is limited to IME geometry', () => {
    const mainActivity = readFileSync(
      resolve(
        repoRoot,
        'src-tauri/gen/android/app/src/main/java/cc/drifting/client/MainActivity.kt',
      ),
      'utf8',
    );
    expect(mainActivity).not.toContain('onBackPressedDispatcher');
    expect(mainActivity).not.toContain('goBack()');
    expect(mainActivity).not.toContain('history.back');
    expect(mainActivity).not.toContain('window.history');
    expect(mainActivity.match(/evaluateJavascript/g)).toHaveLength(1);
    expect(mainActivity).toContain("'--mobile-native-keyboard-inset'");
    expect(mainActivity).toContain("'drifting:native-keyboard-geometry'");
    const mobileCapability = JSON.parse(
      readFileSync(resolve(repoRoot, 'src-tauri/capabilities/mobile.json'), 'utf8'),
    ) as { permissions: string[] };
    expect(mobileCapability.permissions).toEqual(
      expect.arrayContaining([
        'core:app:allow-register-listener',
        'core:app:allow-remove-listener',
      ]),
    );
  });
});
