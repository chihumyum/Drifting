import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { accountService, type DeletionStatus } from '../../../services/account.service';
import { useAuthStore } from '../../../store/auth';
import { authClient } from '../../../lib/auth-client';
import { requestConfirmation } from '../../../store/confirmation-store';
import {
  SettingsPanelHeader,
  SettingsRow,
  SettingsSectionHeader,
  type SettingsRegisterRef,
} from '../SettingsPrimitives';

export function AccountPanel({ registerRef }: { registerRef: SettingsRegisterRef }) {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();

  // Inline editing state for name + email. Password gets its own modal-y
  // sub-form since it needs current + new + confirm.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [emailDraft, setEmailDraft] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);
  const [savingEmail, setSavingEmail] = useState(false);
  const [emailChangeSent, setEmailChangeSent] = useState(false);
  const [emailChangeCode, setEmailChangeCode] = useState('');
  const [emailChangeError, setEmailChangeError] = useState<string | null>(null);

  // Password change form — only mounted when user clicks "更改"
  const [pwOpen, setPwOpen] = useState(false);
  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);

  // Email verification (OTP). Only relevant when user.emailVerified === false.
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [verifyCode, setVerifyCode] = useState('');
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verifySent, setVerifySent] = useState(false);
  const emailVerified = (user as unknown as { emailVerified?: boolean })?.emailVerified ?? false;
  const checkSession = useAuthStore((s) => s.checkSession);

  // Deletion grace period
  const [deletion, setDeletion] = useState<DeletionStatus | null>(null);
  const [deletionBusy, setDeletionBusy] = useState(false);

  // Sessions / devices
  const [sessions, setSessions] = useState<Awaited<
    ReturnType<typeof accountService.listSessions>
  > | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  useEffect(() => {
    void accountService
      .getDeletionStatus()
      .then(setDeletion)
      .catch(() => undefined);
    void accountService
      .listSessions()
      .then(setSessions)
      .catch(() => undefined);
  }, []);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const handleSaveName = async () => {
    if (nameDraft === null) return;
    setSavingName(true);
    try {
      await accountService.changeName(nameDraft.trim());
      setNameDraft(null);
    } catch (err) {
      console.error(err);
    } finally {
      setSavingName(false);
    }
  };

  const handleSaveEmail = async () => {
    if (emailDraft === null) return;
    const nextEmail = emailDraft.trim().toLowerCase();
    setSavingEmail(true);
    setEmailChangeError(null);
    try {
      if (!emailChangeSent) {
        await accountService.requestEmailChange(nextEmail);
        setEmailChangeSent(true);
        return;
      }
      await accountService.confirmEmailChange(nextEmail, emailChangeCode);
      await checkSession();
      setEmailDraft(null);
      setEmailChangeSent(false);
      setEmailChangeCode('');
    } catch (err) {
      setEmailChangeError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingEmail(false);
    }
  };

  const cancelEmailChange = () => {
    setEmailDraft(null);
    setEmailChangeSent(false);
    setEmailChangeCode('');
    setEmailChangeError(null);
  };

  const handleChangePassword = async () => {
    setPwBusy(true);
    setPwError(null);
    try {
      await accountService.changePassword(pwCurrent, pwNew);
      setPwOpen(false);
      setPwCurrent('');
      setPwNew('');
    } catch (err) {
      setPwError(err instanceof Error ? err.message : String(err));
    } finally {
      setPwBusy(false);
    }
  };

  const handleSendVerifyOtp = async () => {
    if (!user?.email) return;
    setVerifyBusy(true);
    setVerifyError(null);
    try {
      const res = await authClient.emailOtp.sendVerificationOtp({
        email: user.email,
        type: 'email-verification',
      });
      if (res.error) throw new Error(res.error.message || t('settings.account.send_failed'));
      setVerifySent(true);
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : String(err));
    } finally {
      setVerifyBusy(false);
    }
  };

  const handleVerifyEmailOtp = async () => {
    if (!user?.email) return;
    setVerifyBusy(true);
    setVerifyError(null);
    try {
      const res = await authClient.emailOtp.verifyEmail({
        email: user.email,
        otp: verifyCode.trim(),
      });
      if (res.error) throw new Error(res.error.message || t('settings.account.verify_failed'));
      setVerifyOpen(false);
      setVerifyCode('');
      setVerifySent(false);
      await checkSession();
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : String(err));
    } finally {
      setVerifyBusy(false);
    }
  };

  const handleRevokeSession = async (id: string) => {
    setRevokingId(id);
    setRevokeError(null);
    try {
      await accountService.revokeSession(id);
      const next = await accountService.listSessions();
      setSessions(next);
    } catch (err) {
      setRevokeError(err instanceof Error ? err.message : String(err));
    } finally {
      setRevokingId(null);
    }
  };

  const handleRequestDeletion = async () => {
    if (!(await requestConfirmation(t('settings.account.delete_confirm')))) return;
    setDeletionBusy(true);
    try {
      const status = await accountService.requestDeletion();
      setDeletion(status);
    } finally {
      setDeletionBusy(false);
    }
  };

  const handleCancelDeletion = async () => {
    setDeletionBusy(true);
    try {
      await accountService.cancelDeletion();
      setDeletion({ pending: false });
    } finally {
      setDeletionBusy(false);
    }
  };

  return (
    <section className="set-panel" ref={registerRef} id="account">
      <SettingsPanelHeader
        kicker={t('settings.account.kicker')}
        title={t('settings.account.title')}
        sub={t('settings.account.sub')}
      />

      <div className="set-sec">
        <SettingsSectionHeader title={t('settings.account.profile')} hint="PUBLIC" />
        <SettingsRow
          label={t('settings.account.display_name')}
          desc={t('settings.account.display_name_desc')}
          control={
            nameDraft !== null ? (
              <>
                <input
                  className="set-input"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  autoFocus
                />
                <button
                  className="set-btn set-btn--primary"
                  onClick={handleSaveName}
                  disabled={savingName}
                >
                  {t('settings.common.save')}
                </button>
                <button className="set-btn" onClick={() => setNameDraft(null)}>
                  {t('settings.common.cancel')}
                </button>
              </>
            ) : (
              <div className="set-field">
                <span className="set-field__value">
                  {user?.name ?? t('settings.account.not_set')}
                </span>
                <button className="set-field__edit" onClick={() => setNameDraft(user?.name ?? '')}>
                  {t('settings.common.edit')}
                </button>
              </div>
            )
          }
        />
        <SettingsRow
          label={t('settings.account.email')}
          desc={t('settings.account.email_desc')}
          control={
            emailDraft !== null ? (
              <>
                <input
                  className="set-input set-input--mono"
                  type="email"
                  value={emailDraft}
                  onChange={(e) => {
                    setEmailDraft(e.target.value);
                    setEmailChangeSent(false);
                    setEmailChangeCode('');
                    setEmailChangeError(null);
                  }}
                  disabled={savingEmail}
                  autoFocus
                />
                {emailChangeSent && (
                  <input
                    className="set-input set-input--mono"
                    inputMode="numeric"
                    maxLength={6}
                    placeholder={t('settings.account.otp_placeholder')}
                    value={emailChangeCode}
                    onChange={(e) =>
                      setEmailChangeCode(e.target.value.replace(/\D/g, '').slice(0, 6))
                    }
                    disabled={savingEmail}
                    autoFocus
                  />
                )}
                <button
                  className="set-btn set-btn--primary"
                  onClick={handleSaveEmail}
                  disabled={
                    savingEmail ||
                    emailDraft.trim().toLowerCase() === user?.email.toLowerCase() ||
                    (emailChangeSent && emailChangeCode.length !== 6)
                  }
                >
                  {emailChangeSent
                    ? t('settings.account.confirm_email_change')
                    : t('settings.account.send_change_code')}
                </button>
                <button className="set-btn" onClick={cancelEmailChange} disabled={savingEmail}>
                  {t('settings.common.cancel')}
                </button>
                {emailChangeError && (
                  <span style={{ color: 'hsl(var(--accent))', fontSize: 12 }}>
                    {emailChangeError}
                  </span>
                )}
              </>
            ) : (
              <div className="set-field">
                <span className="set-field__value set-mono">{user?.email ?? '—'}</span>
                {user?.email &&
                  (emailVerified ? (
                    <span
                      className="set-mono"
                      style={{ fontSize: 11, color: 'hsl(var(--accent))' }}
                    >
                      ✓ {t('settings.account.verified')}
                    </span>
                  ) : (
                    <button
                      className="set-field__edit"
                      onClick={() => {
                        setVerifyOpen((v) => !v);
                        setVerifyError(null);
                      }}
                    >
                      {t('settings.account.verify')}
                    </button>
                  ))}
                <button
                  className="set-field__edit"
                  onClick={() => {
                    setEmailDraft(user?.email ?? '');
                    setEmailChangeSent(false);
                    setEmailChangeCode('');
                    setEmailChangeError(null);
                  }}
                >
                  {t('settings.common.change')}
                </button>
              </div>
            )
          }
        />
        {verifyOpen && !emailVerified && (
          <div
            style={{
              gridColumn: '1 / -1',
              padding: '12px 16px',
              background: 'hsl(var(--paper-deep))',
              borderRadius: 5,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              marginBottom: 12,
            }}
          >
            {!verifySent ? (
              <>
                <div style={{ fontSize: 12, color: 'hsl(var(--ink-3))' }}>
                  {t('settings.account.send_verify_intro')} <code>{user?.email}</code>
                </div>
                {verifyError && (
                  <div style={{ color: 'hsl(var(--accent))', fontSize: 12 }}>{verifyError}</div>
                )}
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    className="set-btn set-btn--primary"
                    onClick={handleSendVerifyOtp}
                    disabled={verifyBusy}
                  >
                    {t('settings.account.send')}
                  </button>
                  <button className="set-btn" onClick={() => setVerifyOpen(false)}>
                    {t('settings.common.cancel')}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 12, color: 'hsl(var(--ink-3))' }}>
                  {t('settings.account.verify_sent_prefix')} <code>{user?.email}</code>
                  {t('settings.account.verify_sent_suffix')}
                </div>
                <input
                  className="set-input set-input--mono"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder={t('settings.account.otp_placeholder')}
                  value={verifyCode}
                  onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                />
                {verifyError && (
                  <div style={{ color: 'hsl(var(--accent))', fontSize: 12 }}>{verifyError}</div>
                )}
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    className="set-btn set-btn--primary"
                    onClick={handleVerifyEmailOtp}
                    disabled={verifyBusy || verifyCode.length !== 6}
                  >
                    {t('settings.account.confirm')}
                  </button>
                  <button className="set-btn" onClick={handleSendVerifyOtp} disabled={verifyBusy}>
                    {t('settings.account.resend')}
                  </button>
                  <button
                    className="set-btn"
                    onClick={() => {
                      setVerifyOpen(false);
                      setVerifySent(false);
                      setVerifyCode('');
                    }}
                  >
                    {t('settings.common.cancel')}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        <SettingsRow
          label={t('settings.account.password')}
          desc={t('settings.account.password_desc')}
          control={
            <button className="set-btn" onClick={() => setPwOpen((v) => !v)}>
              {t('settings.common.change')}
            </button>
          }
        />
        {pwOpen && (
          <div
            style={{
              gridColumn: '1 / -1',
              padding: '12px 16px',
              background: 'hsl(var(--paper-deep))',
              borderRadius: 5,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              marginBottom: 12,
            }}
          >
            <input
              className="set-input"
              type="password"
              placeholder={t('settings.account.current_password')}
              value={pwCurrent}
              onChange={(e) => setPwCurrent(e.target.value)}
            />
            <input
              className="set-input"
              type="password"
              placeholder={t('settings.account.new_password')}
              value={pwNew}
              onChange={(e) => setPwNew(e.target.value)}
            />
            {pwError && <div style={{ color: 'hsl(var(--accent))', fontSize: 12 }}>{pwError}</div>}
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                className="set-btn set-btn--primary"
                onClick={handleChangePassword}
                disabled={pwBusy || pwCurrent.length === 0 || pwNew.length < 8}
              >
                {t('settings.account.save_password')}
              </button>
              <button className="set-btn" onClick={() => setPwOpen(false)}>
                {t('settings.common.cancel')}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="set-sec">
        <SettingsSectionHeader title={t('settings.account.devices')} hint={t('settings.account.devices_hint')} />
        {sessions === null ? (
          <div className="set-row__desc">{t('settings.account.sessions_loading')}</div>
        ) : sessions.length === 0 ? (
          <div className="set-row__desc">{t('settings.account.current_session_only')}</div>
        ) : (
          sessions.map((s) => (
            <div className="set-device" key={s.id}>
              <div className="set-device__glyph">{s.isCurrent ? '▤' : '▢'}</div>
              <div>
                <div className="set-device__name">
                  <b>{s.userAgent ?? t('settings.account.unknown_device')}</b>
                </div>
                <div className="set-device__meta">
                  {s.ipAddress ?? '—'} · {new Date(s.createdAt).toLocaleString()}
                </div>
              </div>
              <div className={'set-device__chip' + (s.isCurrent ? '' : ' set-device__chip--idle')}>
                {s.isCurrent
                  ? t('settings.account.this_device')
                  : t('settings.account.other_device')}
              </div>
              <button
                className="set-btn set-btn--ghost"
                onClick={() => (s.isCurrent ? handleLogout() : handleRevokeSession(s.id))}
                disabled={revokingId === s.id}
              >
                {s.isCurrent
                  ? t('settings.account.logout_device')
                  : revokingId === s.id
                    ? t('settings.account.revoking')
                    : t('settings.account.revoke')}
              </button>
            </div>
          ))
        )}
        {revokeError && (
          <div className="set-row__desc" style={{ color: 'hsl(var(--accent))' }}>
            {t('settings.account.revoke_failed', { error: revokeError })}
          </div>
        )}
      </div>

      <div className="set-sec">
        <SettingsSectionHeader title={t('settings.account.sign_out_title')} hint="SIGN OUT" />
        <SettingsRow
          label={t('settings.account.sign_out_label')}
          desc={t('settings.account.sign_out_desc')}
          control={
            <button className="set-btn set-btn--primary" onClick={handleLogout}>
              {t('settings.account.sign_out_button')}
            </button>
          }
        />
      </div>

      <div className="set-danger">
        <div className="set-danger__title">{t('settings.account.danger_zone')}</div>
        {deletion?.pending ? (
          <SettingsRow
            label={t('settings.account.delete_pending_title')}
            desc={t('settings.account.delete_pending_desc', {
              daysLeft: deletion.daysLeft ?? 30,
              date: deletion.scheduledAt ? new Date(deletion.scheduledAt).toLocaleDateString() : '',
            })}
            control={
              <button className="set-btn" onClick={handleCancelDeletion} disabled={deletionBusy}>
                {t('settings.account.delete_cancel')}
              </button>
            }
          />
        ) : (
          <SettingsRow
            label={t('settings.account.delete_account')}
            desc={t('settings.account.delete_account_desc')}
            control={
              <button
                className="set-btn set-btn--danger"
                onClick={handleRequestDeletion}
                disabled={deletionBusy}
              >
                {t('settings.account.delete_account_btn')}
              </button>
            }
          />
        )}
      </div>
    </section>
  );
}
