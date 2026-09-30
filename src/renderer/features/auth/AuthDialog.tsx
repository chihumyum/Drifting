import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ModalCard, ModalRoot } from '../../components/ui/Modal';
import { getPlatformRuntime } from '../../platform/runtime';
import { hostedAccountSettingsEnabled } from '../settings/hosted-settings-policy';
import { AuthFlow } from './AuthFlow';
import { useAuthDialogStore, type AuthEntryMode } from './auth-dialog-store';

/** Globally mounted desktop sign-in; opened through `useOpenSignIn`. */
export function AuthDialogHost() {
  const request = useAuthDialogStore((state) => state.request);
  const close = useAuthDialogStore((state) => state.close);
  if (!request || !hostedAccountSettingsEnabled() || getPlatformRuntime().isMobileShell) return null;
  return <AuthDialog key={request.id} initialMode={request.mode} onClose={close} />;
}

function AuthDialog({ initialMode, onClose }: { initialMode: AuthEntryMode; onClose(): void }) {
  const { t } = useTranslation();
  const [locked, setLocked] = useState(false);

  // Settings may already own Escape on `document`; claim it first at `window`
  // so Escape closes only this dialog, and never while the library connects.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (!locked) onClose();
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [locked, onClose]);

  return (
    <ModalRoot
      onClose={onClose}
      ariaLabel={t('auth.dialogLabel')}
      closeOnBackdrop={false}
      dismissOnEscape={false}
    >
      <ModalCard className="auth-dialog" width={400}>
        <AuthFlow
          initialMode={initialMode}
          onComplete={onClose}
          onClose={onClose}
          onLockedChange={setLocked}
        />
      </ModalCard>
    </ModalRoot>
  );
}
