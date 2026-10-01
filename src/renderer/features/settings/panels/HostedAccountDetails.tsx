import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../../../store/auth';
import type { HostedProfile } from '../../../lib/hosted-profile';
import {
  HOSTED_NAME_MAX_LENGTH,
  loadHostedAvatar,
  type HostedAvatarSource,
} from '../../../lib/hosted-account';
import { AccountAvatar } from '../../../components/ui/AccountAvatar';
import { SettingsRow, SettingsSectionHeader } from '../SettingsPrimitives';
import { HostedPasswordDialog } from './HostedPasswordDialog';
import { HostedAvatarCropDialog } from './HostedAvatarCropDialog';

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
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [avatarSource, setAvatarSource] = useState<HostedAvatarSource | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ key: string; error: boolean } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const avatarButton = useRef<HTMLButtonElement>(null);
  const operation = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => () => avatarSource?.release(), [avatarSource]);
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
                        const source = await loadHostedAvatar(file);
                        if (mounted.current) setAvatarSource(source);
                        else source.release();
                      });
                  }}
                />
                <button
                  ref={avatarButton}
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
      <SettingsRow
        label={t('settings.hosted.password_title')}
        control={
          <button
            type="button"
            className="set-btn"
            disabled={disabled || busy}
            onClick={() => {
              setNotice(null);
              setPasswordOpen(true);
            }}
          >
            {t('settings.hosted.change_password')}
          </button>
        }
      />
      {passwordOpen && (
        <HostedPasswordDialog
          disabled={disabled}
          onClose={() => setPasswordOpen(false)}
          onSaved={() => {
            setPasswordOpen(false);
            setNotice({ key: 'settings.hosted.password_saved', error: false });
          }}
        />
      )}
      {avatarSource && (
        <HostedAvatarCropDialog
          source={avatarSource}
          returnFocusRef={avatarButton}
          onClose={() => setAvatarSource(null)}
          onConfirm={(cropped) => {
            setImage(cropped);
            setAvatarSource(null);
          }}
        />
      )}
      {notice && (
        <p role={notice.error ? 'alert' : 'status'} className="set-account-notice">
          {t(notice.key)}
        </p>
      )}
    </>
  );
}
