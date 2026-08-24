import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(rendererRoot, '../..');
const source = (path: string) => readFileSync(resolve(rendererRoot, path), 'utf8');

describe('Mobile V2 workspace controller architecture', () => {
  it('replaces shell surface booleans with one reducer-owned state', () => {
    const shell = source('shells/mobile/MobileAppShell.tsx');
    expect(shell).toContain('useReducer(');
    expect(shell).toContain('mobileWorkspaceReducer');
    expect(shell).toContain('workspaceUi.surface.kind');
    expect(shell).not.toMatch(/useState\((?:false|null)\).*overviewOpen/);
    expect(shell).not.toContain('setOverviewOpen');
    expect(shell).not.toContain('setActiveSuperView');
    expect(shell).not.toContain('setTrashOpen');
  });

  it('keeps the five frozen axes and a pure bar projection in one controller', () => {
    const controller = source(
      'shells/mobile/workspace/mobile-workspace-controller.ts',
    );
    for (const axis of ['surface:', 'paperMode:', 'panel:', 'transient:', 'keyboard:']) {
      expect(controller).toContain(axis);
    }
    expect(controller).toContain('resolveMobileWorkspaceBack');
    expect(controller).toContain('selectMobileUnifiedBarProjection');
    expect(controller).toContain('assertLegalMobileWorkspaceState');
  });

  it('routes visible, Escape, Super View, and Android hardware Back through one request', () => {
    const hook = source('shells/mobile/workspace/useMobileWorkspaceBack.ts');
    const androidBack = source('shells/mobile/useMobileAndroidBack.ts');
    const superStack = source('hooks/useSuperViewEscapeStack.ts');
    const superHeader = source('components/SuperViewHeader.tsx');
    const overview = source('shells/mobile/MobileAppShell.tsx');
    expect(androidBack).toContain('androidBackRegistration = onBackButtonPress(() =>');
    expect(androidBack).toContain('const androidBackConsumers = new Set<() => void>()');
    expect(androidBack).toContain("an unregister failure must not become an unhandled rejection");
    expect(hook).toContain("useMobileAndroidBack(() => requestMobileWorkspaceBack('android-hardware'))");
    expect(hook).toContain('resolveMobileWorkspaceBack');
    expect(superStack).toContain('MOBILE_WORKSPACE_BACK_EVENT');
    expect(superHeader).toContain("requestMobileWorkspaceBack('visible')");
    expect(overview).toContain("onClose={() => requestMobileWorkspaceBack('visible')}");
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
