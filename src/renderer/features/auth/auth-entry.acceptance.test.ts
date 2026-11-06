import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useAuthDialogStore } from './auth-dialog-store';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

type Locale = {
  auth: Record<string, unknown> & { fields: Record<string, string> };
  preAlphaGuide: Record<string, string>;
  settings: { hosted: { sign_in_sync_description: string; onboarding: string } };
};

function keyPaths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [prefix];
  return Object.entries(value).flatMap(([key, child]) => keyPaths(child, `${prefix}${key}.`));
}

describe('account sign-in entry', () => {
  it('tells the author plainly when the library already belongs to another account', () => {
    const flow = read('src/renderer/features/auth/AuthFlow.tsx');
    expect(flow).toContain("message.startsWith('HOSTED_ACCOUNT_MISMATCH')");
    expect(flow).toContain("<p className=\"auth-flow__lead\">{t('auth.sync.accountMismatch')}</p>");
    for (const locale of ['zh-CN', 'en']) {
      const sync = (JSON.parse(read(`src/renderer/locales/${locale}.json`)) as Locale).auth.sync as Record<string, string>;
      expect(sync.accountMismatchTitle).toBeTruthy();
      expect(sync.accountMismatch).not.toContain('HOSTED_ACCOUNT_MISMATCH');
      expect(sync.accountMismatchOk).toBeTruthy();
      expect(sync.accountMismatchOpenAccount).toBeTruthy();
    }
  });

  it('asks for local or account use before the shelf mounts, on the phone too', () => {
    const app = read('src/renderer/App.tsx');
    const routes = read('src/renderer/app/AppRoutes.tsx');
    const phoneShelf = read('src/renderer/shells/mobile/standalone/MobileProjectShelfView.tsx');
    const guide = read('src/renderer/components/modals/PreAlphaOnboardingDialog.tsx');
    const css = read('src/styles/auth.css');

    expect(routes).toMatch(/<PreAlphaFirstRunGate>\s*<ProjectPickerView \/>\s*<\/PreAlphaFirstRunGate>/);
    expect(phoneShelf).toMatch(/<PreAlphaFirstRunGate>\s*<ProjectPickerView \/>\s*<\/PreAlphaFirstRunGate>/);
    // Nothing to ask: the shelf as it is; otherwise it mounts only once the card is done.
    expect(guide).toContain("if (stage === 'done' && !throughCard) return <>{children}</>;");
    expect(guide).toContain("const shelf = stage === 'leaving' || stage === 'done' ? (");
    // The welcome's ways on: Google (when the service offers it) and email go to the
    // sign-in step in the same card, the local way dismisses the guide.
    expect(guide).toMatch(/<AuthFlow\s+initialMode="signin"[\s\S]*?onComplete=\{dismiss\}\s*\/>/);
    expect(guide).toContain("void startNativeOAuth('google')");
    expect(guide).toContain('onLocal={dismiss}');
    expect(guide).toContain("const google = !isAppClosedForPublic && providers.includes('google');");
    // Hosted builds still say there that crash reports are sent (docs/crash-reports.md).
    expect(guide).toContain("<p className=\"first-run-welcome__note\">{t('preAlphaGuide.crashReports')}</p>");
    // The phone's old overlay guide is gone: one gate asks on every platform.
    expect(guide).not.toContain('export function PreAlphaOnboardingDialog');
    expect(guide).not.toContain('isMobileShell');
    expect(app).not.toContain('<PreAlphaOnboardingDialog />');
    // The desktop choice is a card in the window, not a dialog over it (char-sea.acceptance.test.ts).
    expect(css).not.toContain('first-run-gate__modal');
    expect(css).toMatch(/\.first-run-gate__pane--account \{\s*width: min\(400px, calc\(100vw - 48px\)\);/);
  });

  it('signs in with a dialog over the current desktop screen', () => {
    const app = read('src/renderer/App.tsx');
    const routes = read('src/renderer/app/AppRoutes.tsx');
    const dialog = read('src/renderer/features/auth/AuthDialog.tsx');
    const store = read('src/renderer/features/auth/auth-dialog-store.ts');
    const entryPoints = [
      read('src/renderer/components/topBars/UserMenu.tsx'),
      read('src/renderer/features/settings/panels/AccountSettingsPanel.tsx'),
    ];

    expect(app).toContain('<AuthDialogHost />');
    expect(routes).toContain('<DesktopAuthRoute mode="signin" />');
    expect(routes).toContain('<DesktopAuthRoute mode="signup" />');
    for (const source of entryPoints) {
      expect(source).toContain('useOpenSignIn()');
      expect(source).not.toContain("navigate('/login')");
    }
    expect(store).toContain(
      "if (getPlatformRuntime().isMobileShell) navigate(mode === 'signup' ? '/register' : '/login');",
    );
    expect(dialog).toContain('<ModalCard className="auth-dialog" width={400}>');
    expect(dialog).toContain('closeOnBackdrop={false}');
    expect(dialog).toContain("window.addEventListener('keydown', handleKeyDown, true)");
    expect(existsSync(resolve(process.cwd(), 'src/renderer/views/LoginPage.tsx'))).toBe(false);
    expect(existsSync(resolve(process.cwd(), 'src/styles/signin.css'))).toBe(false);
  });

  it('starts every dialog request as a fresh flow', () => {
    const store = useAuthDialogStore.getState();
    store.open('signin');
    const first = useAuthDialogStore.getState().request;
    store.open('signup');
    const second = useAuthDialogStore.getState().request;

    expect(first?.mode).toBe('signin');
    expect(second?.mode).toBe('signup');
    expect(second?.id).toBeGreaterThan(first?.id ?? Infinity);
    store.close();
    expect(useAuthDialogStore.getState().request).toBeNull();
  });

  it('keeps the flow compact and states the sync boundary before sign-in', () => {
    const flow = read('src/renderer/features/auth/AuthFlow.tsx');
    const zh = JSON.parse(read('src/renderer/locales/zh-CN.json')) as Locale;
    const en = JSON.parse(read('src/renderer/locales/en.json')) as Locale;

    expect(flow).toContain("t('settings.hosted.sign_in_sync_description')");
    expect(flow).toContain('await finishHostedSignIn(controller.signal);');
    expect(flow).not.toMatch(/kicker|hero|si-tabs/);
    // The desktop dialog uses the shared controls; the paused mobile page keeps its own.
    expect(flow).toContain("const glass = presentation === 'dialog';");
    expect(flow).toContain('<GlassControls.Provider value={glass}>');
    for (const locale of [zh, en]) {
      expect(locale.auth).not.toHaveProperty('hero');
      expect(locale.auth).not.toHaveProperty('controls');
      for (const label of Object.values(locale.auth.fields)) expect(label).not.toContain(' · ');
      expect(locale.preAlphaGuide).not.toHaveProperty('sync');
      expect(locale.preAlphaGuide).not.toHaveProperty('quickGuide');
      expect(JSON.stringify(locale.preAlphaGuide)).not.toMatch(/quick guide|快速指南/i);
    }
    expect(keyPaths(zh.auth).sort()).toEqual(keyPaths(en.auth).sort());
    expect(keyPaths(zh.preAlphaGuide).sort()).toEqual(keyPaths(en.preAlphaGuide).sort());
    // Account-isolated libraries (docs/hosted-sync/account-libraries.md):
    // signing in opens the account's own library; local books stay local.
    // (The retired mobile welcome dialog's own copy of this went with it.)
    expect(zh.settings.hosted.sign_in_sync_description).toMatch(/自己的书库[\s\S]*不会带进账号[\s\S]*回到本机书库/);
    expect(en.settings.hosted.sign_in_sync_description).toMatch(/own library[\s\S]*not brought into the account[\s\S]*local library/);
  });

  it('offers the providers the service declares above email sign-in, and finishes them from anywhere', () => {
    const flow = read('src/renderer/features/auth/AuthFlow.tsx');
    const app = read('src/renderer/App.tsx');
    const effect = read('src/renderer/app/effects/NativeOAuthEffects.tsx');
    const zh = JSON.parse(read('src/renderer/locales/zh-CN.json')) as Locale;

    // Social sign-in is on; which providers show is the service's answer (docs/hosted-sync/README.md).
    expect(flow).not.toContain('SOCIAL_LOGIN_ENABLED');
    expect(flow).toContain('const providers = useOAuthProviders();');
    expect(flow).toContain('const social = isAppClosedForPublic ? [] : providers;');
    expect(flow.indexOf('className="auth-flow__social"')).toBeLessThan(flow.indexOf("label={t('auth.fields.email')}"));
    expect(flow).toContain('<FlowButton kind="text" onClick={cancelNativeOAuth}>');
    // One listener for the whole app, so a cold start or a closed dialog still signs in.
    expect(app).toContain('<NativeOAuthEffects />');
    expect(effect).toContain('if (!hostedAccountSettingsEnabled()) return undefined;');
    expect(flow).not.toContain('platform.auth.onOAuthCallback');
    const errors = zh.auth.errors as Record<string, string>;
    for (const key of ['oauthCancelled', 'oauthExpired', 'oauthAccountNotLinked', 'oauthFailed'])
      expect(errors[key]).not.toMatch(/OAuth|access_denied/);
  });

  it('holds the flow open while the library connects and keeps failures retryable', () => {
    const flow = read('src/renderer/features/auth/AuthFlow.tsx');

    expect(flow).toContain("const locked = step === 'syncing' && !syncError;");
    expect(flow).toContain('{onClose && !locked && (');
    expect(flow).toContain("step === 'syncing'\n        ? undefined");
    expect(flow).toContain("t('auth.sync.retry')");
    expect(flow).toContain("t('auth.sync.later')");
  });
});
