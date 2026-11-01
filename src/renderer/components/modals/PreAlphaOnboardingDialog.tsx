import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { hostedAccountSettingsEnabled } from '../../features/settings/hosted-settings-policy';
import { AuthFlow } from '../../features/auth/AuthFlow';
import { useAuthStore } from '../../store/auth';
import { requestConfirmation } from '../../store/confirmation-store';
import { events } from '../../lib/events';
import { platform } from '../../platform';
import type { MarkdownFolderSettings } from '../../platform/contracts';
import { getPlatformRuntime } from '../../platform/runtime';
import { useCharSeaHold, useCharSeaShape } from '../char-sea/useCharSea';
import { Button } from '../ui/Button';
import { ModalActions, ModalBody, ModalCard, ModalHeader, ModalRoot } from '../ui/Modal';

const GUIDE_VERSION = 'v6';
const FOLDER_GUIDE_KEY = 'drifting.markdown-folder-guide.v1';

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

/** The desktop asks once per device where projects' Markdown folders go. */
function useMarkdownFolderGuide() {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const [dismissed, setDismissed] = useState(false);
  const open = Boolean(
    isAuthenticated &&
    !dismissed &&
    getPlatformRuntime().target === 'desktop' &&
    localStorage.getItem(FOLDER_GUIDE_KEY) !== 'seen',
  );
  const dismiss = useCallback(() => {
    localStorage.setItem(FOLDER_GUIDE_KEY, 'seen');
    setDismissed(true);
  }, []);
  return { open, dismiss };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Where every project's Markdown folder goes. Not choosing keeps the default;
 * turning the folder off is offered too, in the danger ink and behind a
 * confirmation, since external editors and Agents then lose the book.
 */
function MarkdownFolderGuide({ onDone }: { onDone(): void }) {
  const { t } = useTranslation();
  const [folder, setFolder] = useState<MarkdownFolderSettings | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    platform.markdownProjection.folder().then(
      (next) => { if (live) setFolder(next); },
      (failure) => { if (live) setError(errorText(failure)); },
    );
    return () => { live = false; };
  }, []);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  const choose = () => run(async () => {
    const root = await platform.markdownProjection.pickOutputRoot(t('markdownFolderGuide.choose'));
    if (root !== null) setFolder(await platform.markdownProjection.setDefaultRoot(root));
  });
  const turnOff = () => run(async () => {
    const confirmed = await requestConfirmation(t('settings.sync.projection.offWarning'), {
      title: t('settings.sync.projection.offTitle'),
      confirmLabel: t('settings.sync.projection.turnOff'),
      destructive: true,
    });
    if (!confirmed) return;
    await platform.markdownProjection.setEnabled(false);
    onDone();
  });

  return (
    <>
      <ModalHeader title={t('markdownFolderGuide.title')} />
      <ModalBody>
        <p className="pre-alpha-guide-modal__text">{t('markdownFolderGuide.intro')}</p>
        {folder && (
          <div className="markdown-folder-guide__location">
            <div className="markdown-folder-guide__label">
              {t(folder.customRoot ? 'markdownFolderGuide.chosen' : 'markdownFolderGuide.default')}
            </div>
            <code className="markdown-folder-guide__path">{folder.directory}</code>
          </div>
        )}
        {error && <p role="alert" className="markdown-folder-guide__error">{error}</p>}
      </ModalBody>
      <ModalActions>
        <Button
          className="markdown-folder-guide__off"
          variant="danger"
          onClick={() => void turnOff()}
          disabled={busy}
        >
          {t('settings.sync.projection.turnOff')}
        </Button>
        <Button variant="default" onClick={() => void choose()} disabled={busy}>
          {t('markdownFolderGuide.choose')}
        </Button>
        <Button variant="primary" onClick={onDone} disabled={busy || !folder} autoFocus>
          {t(folder?.customRoot ? 'markdownFolderGuide.continue' : 'markdownFolderGuide.useDefault')}
        </Button>
      </ModalActions>
    </>
  );
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
 * opens with the account's cloud projects already restored. Then, once per
 * device, the same card asks where projects' Markdown folders go.
 */
export function PreAlphaFirstRunGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const hosted = hostedAccountSettingsEnabled();
  const session = useAuthStore((state) => state.session);
  const { open: guideOpen, dismiss } = usePreAlphaGuide();
  const folderGuide = useMarkdownFolderGuide();
  const [guideStep, setStep] = useState<'guide' | 'account'>('guide');
  const open = guideOpen || folderGuide.open;
  const step = guideOpen ? guideStep : 'folder';
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
        aria-label={t(step === 'folder' ? 'markdownFolderGuide.title' : 'preAlphaGuide.title')}
      >
        {step === 'folder' ? (
          <MarkdownFolderGuide onDone={folderGuide.dismiss} />
        ) : step === 'account' ? (
          <AuthFlow initialMode="signin" onBack={() => setStep('guide')} onComplete={dismiss} />
        ) : (
          <PreAlphaGuide onOpenAccount={openAccount} onContinueLocal={dismiss} />
        )}
      </section>
    </div>
  );
}
