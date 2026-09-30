import { useCallback, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { hostedAccountSettingsEnabled } from '../../features/settings/hosted-settings-policy';
import { AuthFlow } from '../../features/auth/AuthFlow';
import { useAuthStore } from '../../store/auth';
import { events } from '../../lib/events';
import { platform } from '../../platform';
import { getPlatformRuntime } from '../../platform/runtime';
import { Button } from '../ui/Button';
import { ModalActions, ModalBody, ModalCard, ModalHeader, ModalRoot } from '../ui/Modal';

const GUIDE_VERSION = 'v5';

function usePreAlphaGuide() {
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const storageKey = userId ? `drifting.alpha-guide.${GUIDE_VERSION}:${userId}` : null;
  const open = Boolean(
    isAuthenticated &&
    storageKey &&
    dismissedKey !== storageKey &&
    localStorage.getItem(storageKey) !== 'seen',
  );
  const dismiss = useCallback(() => {
    if (!storageKey) return;
    localStorage.setItem(storageKey, 'seen');
    setDismissedKey(storageKey);
  }, [storageKey]);
  return { open, dismiss };
}

function PreAlphaGuideCard({
  onOpenSyncAndData,
  onContinueLocal,
}: {
  onOpenSyncAndData(): void;
  onContinueLocal(): void;
}) {
  const { t } = useTranslation();
  const hosted = hostedAccountSettingsEnabled();
  const session = useAuthStore((state) => state.session);

  return (
    <ModalCard className="pre-alpha-guide-modal" width={560}>
      <ModalHeader kicker="PUBLIC ALPHA" title={t('preAlphaGuide.title')} />
      <ModalBody>
        <p style={{ margin: 0, color: 'hsl(var(--ink-2))', lineHeight: 1.7 }}>
          {t('preAlphaGuide.intro')}
        </p>
        <div
          style={{
            margin: '20px 0',
            padding: '16px 18px',
            borderRadius: 2,
            background: 'hsl(var(--page))',
          }}
        >
          <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.8 }}>
            <li>{t('preAlphaGuide.localData')}</li>
            <li>{t(hosted ? 'settings.hosted.trust' : 'preAlphaGuide.sync')}</li>
            <li>{t('preAlphaGuide.byok')}</li>
          </ul>
        </div>
        <p style={{ margin: '0 0 20px', color: 'hsl(var(--ink-2))', lineHeight: 1.65 }}>
          {t(hosted ? 'settings.hosted.onboarding' : 'preAlphaGuide.settingsHint')}
        </p>
      </ModalBody>
      <ModalActions>
        {!hosted && <Button
          variant="ghost"
          onClick={() =>
            void platform.material.openExternal('https://drifting.app/quick-start')
          }
        >
          {t('preAlphaGuide.quickGuide')}
        </Button>}
        <Button variant="default" onClick={onOpenSyncAndData}>
          {t(hosted ? (session ? 'settings.hosted.manage' : 'settings.hosted.sign_in_sync') : 'preAlphaGuide.openDrive')}
        </Button>
        <Button
          className="pre-alpha-guide-modal__continue"
          variant="primary"
          onClick={onContinueLocal}
          autoFocus
        >
          {t('preAlphaGuide.continueLocal')}
        </Button>
      </ModalActions>
    </ModalCard>
  );
}

/** Mobile keeps the guide as an overlay; desktop asks first in PreAlphaFirstRunGate. */
export function PreAlphaOnboardingDialog() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const hosted = hostedAccountSettingsEnabled();
  const session = useAuthStore((state) => state.session);
  const { open, dismiss } = usePreAlphaGuide();

  if (!open || !getPlatformRuntime().isMobileShell) return null;

  const openSyncAndData = () => {
    dismiss();
    if (hosted && !session) navigate('/login');
    else queueMicrotask(() => events.emit('settings:open', { railId: hosted ? 'account' : 'sync' }));
  };

  return (
    <ModalRoot
      onClose={dismiss}
      ariaLabel={t('preAlphaGuide.title')}
      closeOnBackdrop={false}
      dismissOnEscape={false}
    >
      <PreAlphaGuideCard onOpenSyncAndData={openSyncAndData} onContinueLocal={dismiss} />
    </ModalRoot>
  );
}

/**
 * Desktop first run asks for local or account use before the shelf mounts.
 * Signing in happens in the same dialog, so the shelf first opens with the
 * account's cloud projects already restored.
 */
export function PreAlphaFirstRunGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const hosted = hostedAccountSettingsEnabled();
  const session = useAuthStore((state) => state.session);
  const { open, dismiss } = usePreAlphaGuide();
  const [step, setStep] = useState<'guide' | 'account'>('guide');

  if (!open) return <>{children}</>;

  const openSyncAndData = () => {
    if (hosted && !session) {
      setStep('account');
      return;
    }
    dismiss();
    navigate(`/settings?section=${hosted ? 'account' : 'sync'}`, { state: { from: '/' } });
  };

  return (
    <div className="first-run-gate">
      {getPlatformRuntime().desktopWindowControls && (
        <div className="first-run-gate__drag" data-tauri-drag-region aria-hidden />
      )}
      <ModalRoot
        className="first-run-gate__modal"
        onClose={dismiss}
        ariaLabel={t('preAlphaGuide.title')}
        closeOnBackdrop={false}
        dismissOnEscape={false}
      >
        {step === 'account' ? (
          <ModalCard className="auth-dialog" width={400}>
            <AuthFlow initialMode="signin" onBack={() => setStep('guide')} onComplete={dismiss} />
          </ModalCard>
        ) : (
          <PreAlphaGuideCard onOpenSyncAndData={openSyncAndData} onContinueLocal={dismiss} />
        )}
      </ModalRoot>
    </div>
  );
}
