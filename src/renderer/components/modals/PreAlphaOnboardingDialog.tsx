import { useCallback, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { hostedAccountSettingsEnabled } from '../../features/settings/hosted-settings-policy';
import { AuthFlow } from '../../features/auth/AuthFlow';
import { useAuthStore } from '../../store/auth';
import { events } from '../../lib/events';
import { getPlatformRuntime } from '../../platform/runtime';
import { useCharSeaHold, useCharSeaShape } from '../char-sea/useCharSea';
import { Button } from '../ui/Button';
import { ModalActions, ModalBody, ModalCard, ModalHeader, ModalRoot } from '../ui/Modal';

const GUIDE_VERSION = 'v6';

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

/** The guide's words and its two ways on; mobile frames them as a dialog, the desktop as a card on the window. */
function PreAlphaGuide({
  onOpenAccount,
  onContinueLocal,
}: {
  onOpenAccount(): void;
  onContinueLocal(): void;
}) {
  const { t } = useTranslation();
  const hosted = hostedAccountSettingsEnabled();
  const session = useAuthStore((state) => state.session);

  return (
    <>
      <ModalHeader kicker="Public Alpha" title={t('preAlphaGuide.title')} />
      <ModalBody>
        <p className="pre-alpha-guide-modal__text">{t('preAlphaGuide.intro')}</p>
        <ul className="pre-alpha-guide-modal__list">
          <li>{t('preAlphaGuide.localData')}</li>
          {hosted && <li>{t('settings.hosted.trust')}</li>}
          <li>{t('preAlphaGuide.byok')}</li>
          {hosted && <li>{t('preAlphaGuide.crashReports')}</li>}
        </ul>
        <p className="pre-alpha-guide-modal__text">
          {t(hosted ? 'settings.hosted.onboarding' : 'preAlphaGuide.settingsHint')}
        </p>
      </ModalBody>
      <ModalActions>
        {hosted && (
          <Button variant="default" onClick={onOpenAccount}>
            {t(session ? 'settings.hosted.manage' : 'preAlphaGuide.accountAction')}
          </Button>
        )}
        <Button
          className="pre-alpha-guide-modal__continue"
          variant="primary"
          onClick={onContinueLocal}
          autoFocus
        >
          {t('preAlphaGuide.continueLocal')}
        </Button>
      </ModalActions>
    </>
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

  const openAccount = () => {
    if (!hosted) return;
    dismiss();
    if (!session) navigate('/login');
    else queueMicrotask(() => events.emit('settings:open', { railId: 'account' }));
  };

  return (
    <ModalRoot
      onClose={dismiss}
      ariaLabel={t('preAlphaGuide.title')}
      closeOnBackdrop={false}
      dismissOnEscape={false}
    >
      <ModalCard className="pre-alpha-guide-modal" width={560}>
        <PreAlphaGuide onOpenAccount={openAccount} onContinueLocal={dismiss} />
      </ModalCard>
    </ModalRoot>
  );
}

/**
 * Desktop first run asks for local or account use before the shelf mounts.
 * The choice is a card laid in the window, not a dialog over it: on the sea of
 * characters the rain falls round it with no word in the middle, the hand
 * still stirs the water, and the sea draws the card's resting glass and shows
 * through it at 12%. Signing in happens in the same card, so the shelf first
 * opens with the account's cloud projects already restored.
 */
export function PreAlphaFirstRunGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const hosted = hostedAccountSettingsEnabled();
  const session = useAuthStore((state) => state.session);
  const { open, dismiss } = usePreAlphaGuide();
  const [step, setStep] = useState<'guide' | 'account'>('guide');
  const { attach: cardRef, drawn: onSea } = useCharSeaShape<HTMLElement>({ rest: 0.85, radius: 2, hover: false });
  useCharSeaHold('rain', open && onSea);

  if (!open) return <>{children}</>;

  const openAccount = () => {
    if (!hosted) return;
    if (!session) {
      setStep('account');
      return;
    }
    dismiss();
    navigate('/settings?section=account', { state: { from: '/' } });
  };

  return (
    <div className={`first-run-gate${onSea ? ' first-run-gate--sea' : ''}`}>
      {getPlatformRuntime().desktopWindowControls && (
        <div className="first-run-gate__drag" data-tauri-drag-region aria-hidden />
      )}
      <section
        ref={cardRef}
        className={`first-run-gate__card first-run-gate__card--${step} glass glass--rest glass--still${onSea ? ' first-run-gate__card--sea' : ''}`}
        aria-label={t('preAlphaGuide.title')}
      >
        {step === 'account' ? (
          <AuthFlow initialMode="signin" onBack={() => setStep('guide')} onComplete={dismiss} />
        ) : (
          <PreAlphaGuide onOpenAccount={openAccount} onContinueLocal={dismiss} />
        )}
      </section>
    </div>
  );
}
