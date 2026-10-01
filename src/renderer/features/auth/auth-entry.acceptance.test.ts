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
  it('asks for local or account use before the desktop shelf mounts', () => {
    const routes = read('src/renderer/app/AppRoutes.tsx');
    const guide = read('src/renderer/components/modals/PreAlphaOnboardingDialog.tsx');
    const css = read('src/styles/auth.css');

    expect(routes).toMatch(/<PreAlphaFirstRunGate>\s*<ProjectPickerView \/>\s*<\/PreAlphaFirstRunGate>/);
    expect(guide).toContain('if (!open) return <>{children}</>;');
    expect(guide).toContain(
      `<AuthFlow initialMode="signin" onBack={() => setStep('guide')} onComplete={dismiss} />`,
    );
    // Mobile keeps the overlay guide and its full-page authentication route.
    expect(guide).toContain('if (!open || !getPlatformRuntime().isMobileShell) return null;');
    expect(guide).toContain("if (!session) navigate('/login');");
    expect(css).toMatch(/\.modal-root\.first-run-gate__modal \{\s*background: transparent;/);
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
    for (const locale of [zh, en]) {
      expect(locale.auth).not.toHaveProperty('hero');
      expect(locale.auth).not.toHaveProperty('controls');
      for (const label of Object.values(locale.auth.fields)) expect(label).not.toContain(' · ');
      expect(locale.preAlphaGuide).not.toHaveProperty('sync');
      expect(locale.preAlphaGuide).not.toHaveProperty('openDrive');
      expect(locale.preAlphaGuide).not.toHaveProperty('quickGuide');
      expect(JSON.stringify(locale.preAlphaGuide)).not.toMatch(/Google Drive|quick guide|快速指南/i);
    }
    expect(keyPaths(zh.auth).sort()).toEqual(keyPaths(en.auth).sort());
    expect(keyPaths(zh.preAlphaGuide).sort()).toEqual(keyPaths(en.preAlphaGuide).sort());
    expect(zh.preAlphaGuide.accountAction).toMatch(/登录.*注册/);
    expect(en.preAlphaGuide.accountAction).toMatch(/Sign in.*sign up/);
    expect(zh.settings.hosted.onboarding).toMatch(/下载[\s\S]*上传/);
    expect(en.settings.hosted.onboarding).toMatch(/download[\s\S]*upload/);
    expect(zh.settings.hosted.sign_in_sync_description).toMatch(/下载[\s\S]*上传/);
    expect(en.settings.hosted.sign_in_sync_description).toMatch(/downloads[\s\S]*uploads/);
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
