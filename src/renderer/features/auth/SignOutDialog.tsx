import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BrushIcon } from '../../components/ui/BrushIcon';
import { Button } from '../../components/ui/Button';
import { ModalActions, ModalBody, ModalCard, ModalHeader, ModalRoot } from '../../components/ui/Modal';
import { Switch } from '../../components/ui/Switch';
import { useAuthStore } from '../../store/auth';
import { useProductSyncAuthority } from '../../sync/product-authority-react';
import { useProductSyncRuntime } from '../../sync/product-runtime-react';
import { waitForHostedUpload } from '../../sync/hosted/disconnect';
import { finishSignOut, useSignOutDialogStore } from './sign-out';
import { librarySwitchingAvailable } from '../../services/account-library';
import '../../../styles/auth.css';

/** Globally mounted sign-out dialog; opened through `requestSignOut`. */
export function SignOutDialogHost() {
  const request = useSignOutDialogStore((state) => state.request);
  const close = useSignOutDialogStore((state) => state.close);
  if (!request) return null;
  return (
    <SignOutDialog
      key={request.id}
      unuploaded={request.unuploaded}
      afterSignOut={request.afterSignOut}
      onClose={close}
    />
  );
}

type Phase = 'asking' | 'uploading' | 'signing-out';

/**
 * Says how many changes only this Mac holds and lets the author upload them
 * before signing out, or sign out now and leave them here. The switch also
 * disconnects the library's sync, for moving it to another account.
 */
export function SignOutDialog({
  unuploaded,
  afterSignOut,
  onClose,
}: {
  unuploaded: number;
  afterSignOut?: () => void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const authority = useProductSyncAuthority();
  const runtime = useProductSyncRuntime();
  const accountReady = useAuthStore((s) => s.hostedStatus === 'connected');
  const connected = authority.mode === 'hosted';
  const canUpload = connected && accountReady && authority.status !== 'cloud-paused' && runtime.mounted;
  const [disconnect, setDisconnect] = useState(false);
  const [phase, setPhase] = useState<Phase>('asking');
  const [remaining, setRemaining] = useState(unuploaded);
  const [error, setError] = useState<string | null>(null);
  const operation = useRef<{ abort: AbortController; stopWaiting: AbortController } | null>(null);
  useEffect(() => () => operation.current?.abort.abort(), []);

  const cancel = useCallback(() => {
    operation.current?.abort.abort();
    onClose();
  }, [onClose]);

  // Settings may already own Escape on `document`; claim it first at `window`
  // so Escape closes only this dialog, and never while signing out.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (phase !== 'signing-out') cancel();
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [cancel, phase]);

  const signOut = async (uploadFirst: boolean) => {
    if (operation.current) return;
    const current = { abort: new AbortController(), stopWaiting: new AbortController() };
    operation.current = current;
    const { signal } = current.abort;
    setError(null);
    try {
      if (uploadFirst) {
        setPhase('uploading');
        await waitForHostedUpload(signal, { stopWaiting: current.stopWaiting.signal, onRemaining: setRemaining });
      }
      setPhase('signing-out');
      await finishSignOut(signal, { disconnect });
      onClose();
      afterSignOut?.();
    } catch (failure) {
      if (signal.aborted) return;
      setError(failure instanceof Error ? failure.message : String(failure));
      setPhase('asking');
    } finally {
      if (operation.current === current) operation.current = null;
    }
  };

  const title = t('auth.signOut.title');
  return (
    <ModalRoot onClose={cancel} ariaLabel={title} closeOnBackdrop={false} dismissOnEscape={false}>
      <ModalCard className="sign-out-dialog" width={440}>
        <ModalHeader
          title={title}
          onClose={phase === 'signing-out' ? undefined : cancel}
          closeLabel={t('common.cancel')}
        />
        <ModalBody>
          <div className="confirmation-dialog__message" role="status">
            {phase === 'uploading'
              ? t('auth.signOut.uploading', { count: remaining })
              : t(disconnect ? 'auth.signOut.pendingLocal' : 'auth.signOut.pending', { count: remaining })}
          </div>
          {/* With account libraries, signing out already leaves this account's
              library behind; only a single-library host switches by disconnecting. */}
          {connected && !librarySwitchingAvailable() && (
            <label className="sign-out-dialog__switch">
              <Switch
                size="sm"
                checked={disconnect}
                disabled={phase !== 'asking'}
                onCheckedChange={setDisconnect}
                aria-label={t('auth.signOut.disconnect')}
              />
              <span>{t('auth.signOut.disconnect')}</span>
            </label>
          )}
          {error && (
            <p className="sign-out-dialog__error" role="alert">
              <BrushIcon name="status-warning" size={14} />
              {error}
            </p>
          )}
        </ModalBody>
        <ModalActions>
          {phase === 'signing-out' ? (
            <Button disabled>
              <BrushIcon name="loader" size={14} className="ui-spin" />
              {t('userMenu.signingOut')}
            </Button>
          ) : phase === 'uploading' ? (
            <>
              <Button onClick={cancel}>{t('common.cancel')}</Button>
              <Button onClick={() => operation.current?.stopWaiting.abort()}>{t('auth.signOut.stopWaiting')}</Button>
            </>
          ) : (
            <>
              <Button onClick={cancel}>{t('common.cancel')}</Button>
              <Button autoFocus={!canUpload} onClick={() => void signOut(false)}>
                {t('auth.signOut.now')}
              </Button>
              {canUpload && (
                <Button variant="primary" autoFocus onClick={() => void signOut(true)}>
                  {t('auth.signOut.uploadFirst')}
                </Button>
              )}
            </>
          )}
        </ModalActions>
      </ModalCard>
    </ModalRoot>
  );
}
