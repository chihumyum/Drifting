import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../../../store/auth';
import type { HostedProfile } from '../../../lib/hosted-profile';
import {
  HOSTED_NAME_MAX_LENGTH,
  prepareHostedAvatar,
  validateHostedPassword,
} from '../../../lib/hosted-account';
import { AccountAvatar } from '../../../components/ui/AccountAvatar';
import { SettingsRow, SettingsSectionHeader } from '../SettingsPrimitives';

export function HostedAccountDetails({
  user,
  disabled,
}: {
  user: HostedProfile;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState<string | null>(null);
  const [image, setImage] = useState<string | null | undefined>(undefined);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ key: string; error: boolean } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const operation = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const displayName = name ?? user.name;
  const displayImage = image === undefined ? user.image : image;
  const dirty = displayName.trim() !== user.name || (displayImage ?? null) !== (user.image ?? null);
  const run = async (action: () => Promise<void>, success?: string) => {
    if (operation.current || disabled) return;
    operation.current = true;
    setBusy(true);
    setNotice(null);
    try {
      await action();
      if (mounted.current && success) setNotice({ key: success, error: false });
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      const key = `settings.hosted.account_errors.${code}`;
      if (mounted.current)
        setNotice({
          key: t(key, { defaultValue: '' }) ? key : 'settings.hosted.account_errors.generic',
          error: true,
        });
    } finally {
      operation.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <>
      <SettingsSectionHeader title={t('settings.hosted.profile_title')} />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!dirty) return;
          void run(async () => {
            await useAuthStore.getState().updateHostedProfile({
              ...(name !== null ? { name } : {}),
              ...(image !== undefined ? { image } : {}),
            });
            if (mounted.current) {
              setName(null);
              setImage(undefined);
            }
          }, 'settings.hosted.profile_saved');
        }}
      >
        <fieldset className="set-account-fields" disabled={disabled || busy}>
          <SettingsRow
            label={t('settings.hosted.avatar')}
            desc={t('settings.hosted.avatar_description')}
            control={
              <>
                <span className="set-account-avatar" aria-label={t('settings.hosted.avatar')}>
                  <AccountAvatar
                    image={displayImage}
                    initial={(displayName || user.email)[0].toUpperCase()}
                  />
                </span>
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  hidden
                  aria-label={t('settings.hosted.choose_avatar')}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file)
                      void run(async () => {
                        const prepared = await prepareHostedAvatar(file);
                        if (mounted.current) setImage(prepared);
                      });
                  }}
                />
                <button
                  type="button"
                  className="set-btn"
                  onClick={() => fileInput.current?.click()}
                >
                  {t('settings.hosted.choose_avatar')}
                </button>
                {displayImage && (
                  <button
                    type="button"
                    className="set-btn set-btn--ghost"
                    onClick={() => setImage(null)}
                  >
                    {t('settings.hosted.remove_avatar')}
                  </button>
                )}
              </>
            }
          />
          <SettingsRow
            label={<label htmlFor="hosted-name">{t('settings.hosted.display_name')}</label>}
            control={
              <input
                id="hosted-name"
                className="set-input"
                autoComplete="nickname"
                required
                maxLength={HOSTED_NAME_MAX_LENGTH}
                value={displayName}
                onChange={(event) => setName(event.target.value)}
              />
            }
          />
          <div className="set-account-actions">
            <button
              className="set-btn set-btn--primary"
              type="submit"
              disabled={!dirty || !displayName.trim()}
            >
              {t('settings.hosted.save_profile')}
            </button>
            {dirty && (
              <button
                type="button"
                className="set-btn"
                onClick={() => {
                  setName(null);
                  setImage(undefined);
                  setNotice(null);
                }}
              >
                {t('common.cancel')}
              </button>
            )}
          </div>
        </fieldset>
      </form>
      <SettingsSectionHeader title={t('settings.hosted.password_title')} />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            validateHostedPassword(currentPassword, newPassword, confirmation);
            try {
              await useAuthStore
                .getState()
                .changeHostedPassword(currentPassword, newPassword, confirmation);
            } finally {
              if (mounted.current) {
                setCurrentPassword('');
                setNewPassword('');
                setConfirmation('');
              }
            }
          }, 'settings.hosted.password_saved');
        }}
      >
        <fieldset className="set-account-fields" disabled={disabled || busy}>
          <SettingsRow
            label={
              <label htmlFor="hosted-current-password">
                {t('settings.hosted.current_password')}
              </label>
            }
            control={
              <input
                id="hosted-current-password"
                className="set-input"
                type="password"
                autoComplete="current-password"
                required
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            }
          />
          <SettingsRow
            label={<label htmlFor="hosted-new-password">{t('settings.hosted.new_password')}</label>}
            desc={t('settings.hosted.password_description')}
            control={
              <input
                id="hosted-new-password"
                className="set-input"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                maxLength={128}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
            }
          />
          <SettingsRow
            label={
              <label htmlFor="hosted-confirm-password">
                {t('settings.hosted.confirm_password')}
              </label>
            }
            control={
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
            }
          />
          <p className="set-row__desc">{t('settings.hosted.password_sessions')}</p>
          <div className="set-account-actions">
            <button
              className="set-btn"
              type="submit"
              disabled={!currentPassword || !newPassword || !confirmation}
            >
              {t('settings.hosted.change_password')}
            </button>
          </div>
        </fieldset>
      </form>
      {notice && (
        <p role={notice.error ? 'alert' : 'status'} className="set-account-notice">
          {t(notice.key)}
        </p>
      )}
    </>
  );
}
