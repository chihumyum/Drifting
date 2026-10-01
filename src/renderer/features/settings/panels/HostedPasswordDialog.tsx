import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../../../store/auth';
import { validateHostedPassword } from '../../../lib/hosted-account';
import { Button } from '../../../components/ui/Button';
import { ModalActions, ModalBody, ModalHeader } from '../../../components/ui/Modal';
import { HostedAccountDialog } from './HostedAccountDialog';

export function HostedPasswordDialog({
  disabled,
  onClose,
  onSaved,
}: {
  disabled: boolean;
  onClose(): void;
  onSaved(): void;
}) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const submit = async () => {
    if (pending.current || disabled) return;
    setError(null);
    try {
      validateHostedPassword(current, next, confirmation);
      pending.current = true;
      setBusy(true);
      try {
        await useAuthStore.getState().changeHostedPassword(current, next, confirmation);
      } finally {
        if (mounted.current) {
          setCurrent('');
          setNext('');
          setConfirmation('');
        }
      }
      if (mounted.current) onSaved();
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : 'generic');
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <HostedAccountDialog title={t('settings.hosted.change_password')} busy={busy} onClose={onClose}>
      <ModalHeader
        title={t('settings.hosted.change_password')}
        onClose={busy ? undefined : onClose}
        closeLabel={t('common.close')}
      />
      <form
        className="set-account-dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <ModalBody>
          <fieldset
            className="set-account-fields set-account-password-fields"
            disabled={disabled || busy}
          >
            <label htmlFor="hosted-current-password">{t('settings.hosted.current_password')}</label>
            <input
              id="hosted-current-password"
              className="set-input"
              data-dialog-autofocus
              type="password"
              autoComplete="current-password"
              required
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
            />
            <label htmlFor="hosted-new-password">{t('settings.hosted.new_password')}</label>
            <input
              id="hosted-new-password"
              className="set-input"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              maxLength={128}
              aria-describedby="hosted-password-length"
              value={next}
              onChange={(event) => setNext(event.target.value)}
            />
            <p id="hosted-password-length" className="set-row__desc">
              {t('settings.hosted.password_description')}
            </p>
            <label htmlFor="hosted-confirm-password">{t('settings.hosted.confirm_password')}</label>
            <input
              id="hosted-confirm-password"
              className="set-input"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              maxLength={128}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </fieldset>
          <p className="set-row__desc">{t('settings.hosted.password_sessions')}</p>
          {error && (
            <p role="alert" className="set-account-notice">
              {t(`settings.hosted.account_errors.${error}`, {
                defaultValue: t('settings.hosted.account_errors.generic'),
              })}
            </p>
          )}
        </ModalBody>
        <ModalActions>
          <Button disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || disabled || !current || !next || !confirmation}
          >
            {t(busy ? 'settings.hosted.working' : 'settings.hosted.change_password')}
          </Button>
        </ModalActions>
      </form>
    </HostedAccountDialog>
  );
}
