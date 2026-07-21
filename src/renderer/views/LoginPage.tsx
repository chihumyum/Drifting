import { Fragment, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Moon, Sun } from 'lucide-react';
import { useAuthStore } from '../store/auth';
import { useSettingsStore } from '../store/settings-store';
import { authClient } from '../lib/auth-client';
import { setSessionToken } from '../lib/session-token';
import { platform } from '../platform';
import { getPlatformRuntime } from '../platform/runtime';
import { UI_LOCALE_OPTIONS } from '../lib/i18n';
import type { SupportedOAuthProvider } from '../lib/oauth-providers';
import { APP_CLOSED_MESSAGE, isAppClosedForPublic } from '../utils/appAccess';
import { BetaClosedDialog } from '../components/auth/BetaClosedDialog';
import '../../styles/signin.css';

type Mode = 'signin' | 'signup' | 'forgot' | 'otp' | 'verifyAfterSignup';

interface SocialProvider {
  key: string;
  iconClass: string;
  icon: string;
  signInLabelKey: string;
  signUpLabelKey: string;
  sub: string;
  oauth?: SupportedOAuthProvider;
}

const SOCIAL_PROVIDERS: SocialProvider[] = [
  {
    key: 'google',
    iconClass: 'si-soc-btn__icon--g',
    icon: 'G',
    signInLabelKey: 'auth.social.googleSignIn',
    signUpLabelKey: 'auth.social.googleSignUp',
    sub: 'OAuth',
    oauth: 'google',
  },
  {
    key: 'apple',
    iconClass: 'si-soc-btn__icon--a',
    icon: '⌘',
    signInLabelKey: 'auth.social.appleSignIn',
    signUpLabelKey: 'auth.social.appleSignUp',
    sub: 'Sign in with Apple',
  },
  {
    key: 'wechat',
    iconClass: 'si-soc-btn__icon--w',
    icon: 'W',
    signInLabelKey: 'auth.social.wechatSignIn',
    signUpLabelKey: 'auth.social.wechatSignUp',
    sub: 'WeChat',
  },
];

// Social sign-in is OFF for the BYOK-only beta. Google OAuth still injects a
// cookie (broken under the new bearer-token flow), and Apple/WeChat are mere
// placeholders. The whole block is kept in code behind this flag for a proper
// pass later. Typed `boolean` (not literal false) so the gated JSX still
// type-checks and its handlers don't read as dead code.
const SOCIAL_LOGIN_ENABLED: boolean = false;

function LoginQuickToggles() {
  const { t } = useTranslation();
  const themeMode = useSettingsStore((s) => s.themeMode);
  const setThemeMode = useSettingsStore((s) => s.setThemeMode);
  const uiLocale = useSettingsStore((s) => s.uiLocale);
  const setUiLocale = useSettingsStore((s) => s.setUiLocale);
  const normalizedUiLocale = uiLocale.startsWith('zh') ? 'zh-CN' : 'en';
  const darkActive = themeMode === 'dark';

  return (
    <div className="si-controls" role="group" aria-label={t('auth.controls.title')}>
      <div className="si-controls__seg" role="group" aria-label={t('auth.controls.language')}>
        {UI_LOCALE_OPTIONS.map((locale) => (
          <button
            key={locale.code}
            type="button"
            className={`si-controls__btn${normalizedUiLocale === locale.code ? ' si-controls__btn--active' : ''}`}
            onClick={() => setUiLocale(locale.code)}
            title={locale.name}
            aria-pressed={normalizedUiLocale === locale.code}
          >
            {locale.code === 'zh-CN' ? '中' : 'EN'}
          </button>
        ))}
      </div>
      <button
        type="button"
        className={`si-controls__icon${darkActive ? ' si-controls__icon--active' : ''}`}
        onClick={() => setThemeMode(darkActive ? 'light' : 'dark')}
        title={darkActive ? t('auth.controls.switchToLight') : t('auth.controls.switchToDark')}
        aria-label={darkActive ? t('auth.controls.switchToLight') : t('auth.controls.switchToDark')}
        aria-pressed={darkActive}
      >
        {darkActive ? <Sun size={14} aria-hidden="true" /> : <Moon size={14} aria-hidden="true" />}
      </button>
    </div>
  );
}

interface LoginPageProps {
  initialMode?: Exclude<Mode, 'forgot'>;
}

export function LoginPage({ initialMode = 'signin' }: LoginPageProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const adoptSession = useAuthStore((state) => state.adoptSession);

  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<SupportedOAuthProvider | null>(null);
  const [showClosedDialog, setShowClosedDialog] = useState(false);

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
  };

  const completeAfterSignIn = async () => {
    try {
      await adoptSession();
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.errors.signInFailed'));
    }
  };

  useEffect(() => {
    const cleanup = platform.auth.onOAuthCallback(async ({ token, error: callbackError }) => {
      setOauthLoading(null);
      if (callbackError || !token) {
        setError(t('auth.errors.oauthFailed'));
        return;
      }
      try {
        setSessionToken(token);
        await adoptSession();
        navigate('/');
      } catch {
        setError(t('auth.errors.sessionFailed'));
      }
    });
    return cleanup;
  }, [adoptSession, navigate, t]);

  const handleOAuth = async (provider: SupportedOAuthProvider) => {
    setError(null);
    setOauthLoading(provider);
    try {
      await platform.auth.openOAuthBrowser(provider);
    } catch {
      setError(t('auth.errors.browserFailed'));
      setOauthLoading(null);
    }
  };

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    if (mode === 'signup' && isAppClosedForPublic) {
      setError(APP_CLOSED_MESSAGE);
      setShowClosedDialog(true);
      return;
    }

    setIsSubmitting(true);
    try {
      if (mode === 'signin') {
        const result = await authClient.signIn.email({ email, password });
        if (result.error) {
          // Server returns this when emailVerified=false (requireEmailVerification
          // is on). Drive the user through the OTP gate instead of just throwing.
          const code = (result.error as { code?: string; status?: number }).code ?? '';
          const status = (result.error as { status?: number }).status;
          if (code === 'EMAIL_NOT_VERIFIED' || status === 403) {
            setMode('verifyAfterSignup');
            return;
          }
          throw new Error(result.error.message || t('auth.errors.signInFailed'));
        }
        await adoptSession();
        navigate('/');
      } else {
        // Signup. With requireEmailVerification=true the server creates the
        // user without an active session. We keep the (email, password) in
        // state so the post-verify step can sign in cleanly.
        const result = await authClient.signUp.email({ email, password, name });
        if (result.error) {
          throw new Error(result.error.message || t('auth.errors.signUpFailed'));
        }
        setMode('verifyAfterSignup');
      }
    } catch (err) {
      const fallback =
        mode === 'signin' ? t('auth.errors.signInCheck') : t('auth.errors.signUpRetry');
      setError(err instanceof Error ? err.message : fallback);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="signin">
      <LoginQuickToggles />
      {/* ═══ Left · editorial / brand ═══ */}
      <aside className="si-left">
        <div className="si-brand">
          <span className="si-brand__name">Drifting</span>
          <span className="si-brand__sep">/</span>
          <span className="si-brand__cn">{t('auth.brand.cn')}</span>
        </div>

        <div className="si-quote">
          <div className="si-quote__kicker">
            <span className="si-quote__kicker-dot"></span>
            <span>{t('auth.hero.kickerA')}</span>
            <span className="si-quote__kicker-sep">·</span>
            <span>{t('auth.hero.kickerB')}</span>
          </div>
          <h1 className="si-quote__title">
            {t('auth.hero.titleA')}
            <em>{t('auth.hero.titleEmA')}</em>。<br />
            {t('auth.hero.titleB')}
            <em>{t('auth.hero.titleEmB')}</em>。
          </h1>
          <p className="si-quote__body">{t('auth.hero.body')}</p>

          <div className="si-feats">
            <div className="si-feat">
              <span className="si-feat__mark">§</span>
              <div className="si-feat__body">
                <span className="si-feat__title">
                  {t('auth.hero.featureOutlineTitle')} · <em>{t('auth.hero.featureOutlineEm')}</em>
                </span>
                <span className="si-feat__sub">{t('auth.hero.featureOutlineSub')}</span>
              </div>
            </div>
            <div className="si-feat">
              <span className="si-feat__mark">◆</span>
              <div className="si-feat__body">
                <span className="si-feat__title">{t('auth.hero.featureElementTitle')}</span>
                <span className="si-feat__sub">{t('auth.hero.featureElementSub')}</span>
              </div>
            </div>
            <div className="si-feat">
              <span className="si-feat__mark">¶</span>
              <div className="si-feat__body">
                <span className="si-feat__title">
                  {t('auth.hero.featureStorylineTitleA')} ·{' '}
                  <em>{t('auth.hero.featureStorylineEm')}</em>
                  {t('auth.hero.featureStorylineTitleB')}
                </span>
                <span className="si-feat__sub">{t('auth.hero.featureStorylineSub')}</span>
              </div>
            </div>
            <div className="si-feat">
              <span className="si-feat__mark">◐</span>
              <div className="si-feat__body">
                <span className="si-feat__title">{t('auth.hero.featureShadowTitle')}</span>
                <span className="si-feat__sub">{t('auth.hero.featureShadowSub')}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="si-foot">
          <span>
            {t('auth.hero.brandVersion', {
              version: getPlatformRuntime().appInfo?.version ?? '0.1.0',
            })}
          </span>
          <span className="si-foot__orn">⁂</span>
          <span>{t('auth.hero.footer')}</span>
        </div>
      </aside>

      {/* ═══ Right · form ═══ */}
      <main className="si-right">
        <div className="si-tabs">
          <button
            type="button"
            className={`si-tab ${mode === 'signin' ? 'si-tab--active' : ''}`}
            onClick={() => switchMode('signin')}
          >
            <span>{t('auth.signIn')}</span>
          </button>
          <button
            type="button"
            className={`si-tab ${mode === 'signup' ? 'si-tab--active' : ''}`}
            onClick={() => switchMode('signup')}
          >
            <span>{t('auth.signUp')}</span>
          </button>
        </div>

        {mode === 'otp' ? (
          <OtpForm
            initialEmail={email}
            onCancel={() => switchMode('signin')}
            onSuccess={completeAfterSignIn}
          />
        ) : mode === 'verifyAfterSignup' ? (
          <VerifyAfterSignupForm
            email={email}
            password={password}
            onCancel={() => switchMode('signin')}
            onSuccess={completeAfterSignIn}
          />
        ) : mode === 'forgot' ? (
          <ForgotForm onCancel={() => switchMode('signin')} />
        ) : (
          <form className="si-form" onSubmit={submit}>
            <div className="si-kicker">
              <span className="si-kicker-dot"></span>
              <span>{mode === 'signin' ? t('auth.signin.kicker') : t('auth.signup.kicker')}</span>
            </div>
            <h2 className="si-form__title">
              {mode === 'signin' ? (
                <Fragment>
                  <em>{t('auth.signIn')}</em> Drifting
                </Fragment>
              ) : (
                <Fragment>
                  <em>{t('auth.signup.titleEm')}</em>
                  {t('auth.signup.titleRest')}
                </Fragment>
              )}
            </h2>
            <p className="si-form__sub">
              {mode === 'signin' ? t('auth.signin.sub') : t('auth.signup.sub')}
            </p>

            {error && <div className="si-error">{error}</div>}

            {mode === 'signup' && (
              <div className="si-field">
                <span className="si-field__k">{t('auth.fields.penName')}</span>
                <input
                  className="si-field__input"
                  placeholder={t('auth.fields.penNamePlaceholder')}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={isSubmitting}
                  required
                  autoFocus
                />
              </div>
            )}

            <div className="si-field">
              <span className="si-field__k">{t('auth.fields.email')}</span>
              <input
                className="si-field__input"
                type="email"
                placeholder={t('auth.fields.emailPlaceholder')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isSubmitting}
                required
                autoFocus={mode === 'signin'}
              />
            </div>

            <div className="si-field">
              <span className="si-field__k">
                {t('auth.fields.password')}
                {mode === 'signin' && <a onClick={() => switchMode('otp')}>{t('auth.useOtp')} →</a>}
              </span>
              <input
                className="si-field__input"
                type="password"
                placeholder={
                  mode === 'signup' ? t('auth.fields.passwordSignupPlaceholder') : '••••••••'
                }
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isSubmitting}
                required
                minLength={mode === 'signup' ? 10 : undefined}
              />
            </div>

            <button type="submit" className="si-submit" disabled={isSubmitting}>
              <span className="si-submit__cn">
                {isSubmitting
                  ? mode === 'signin'
                    ? t('auth.signingIn')
                    : t('auth.creating')
                  : mode === 'signin'
                    ? t('auth.signIn')
                    : t('auth.createAccount')}
              </span>
              <span>
                {mode === 'signin' ? t('auth.signInShort') : t('auth.createAccountShort')}
              </span>
              <span className="si-submit__arrow">→</span>
            </button>

            {SOCIAL_LOGIN_ENABLED && (
              <>
                <div className="si-or">{t('auth.social.or')}</div>

                <div className="si-social">
                  {SOCIAL_PROVIDERS.map((p) => {
                    const enabled = !!p.oauth;
                    const loading = p.oauth && oauthLoading === p.oauth;
                    return (
                      <button
                        key={p.key}
                        type="button"
                        className="si-soc-btn"
                        onClick={
                          enabled ? () => handleOAuth(p.oauth as SupportedOAuthProvider) : undefined
                        }
                        disabled={!enabled || isSubmitting || oauthLoading !== null}
                        title={enabled ? undefined : t('auth.social.comingSoon')}
                      >
                        <span className={`si-soc-btn__icon ${p.iconClass}`}>{p.icon}</span>
                        <span className="si-soc-btn__label">
                          {loading
                            ? t('auth.social.waiting')
                            : mode === 'signin'
                              ? t(p.signInLabelKey)
                              : t(p.signUpLabelKey)}
                        </span>
                        <span className="si-soc-btn__sub">
                          {enabled ? p.sub : t('auth.social.comingSoon')}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            <div className="si-foot-right">
              {mode === 'signin' ? (
                <Fragment>
                  <span>{t('auth.noAccount')}</span>
                  <a onClick={() => switchMode('signup')}>{t('auth.signUpNow')} →</a>
                </Fragment>
              ) : (
                <Fragment>
                  <span>{t('auth.hasAccount')}</span>
                  <a onClick={() => switchMode('signin')}>{t('auth.signIn')} →</a>
                </Fragment>
              )}
            </div>

            <div className="si-legal">
              {mode === 'signup' && (
                <Fragment>
                  {t('auth.legal.agree')} <a>{t('auth.legal.terms')}</a> {t('auth.legal.and')}{' '}
                  <a>{t('auth.legal.privacy')}</a>。<br />
                </Fragment>
              )}
              {t('auth.legal.footer')}
            </div>
          </form>
        )}
      </main>

      <BetaClosedDialog open={showClosedDialog} onClose={() => setShowClosedDialog(false)} />
    </div>
  );
}

const ForgotForm = ({ onCancel }: { onCancel: () => void }) => {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<'email' | 'reset' | 'done'>('email');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendCode = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await authClient.emailOtp.requestPasswordReset({ email });
      if (result.error) throw new Error(result.error.message || t('auth.errors.sendCodeFailed'));
      setPhase('reset');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.errors.sendCodeFailed'));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (phase === 'email') {
      await sendCode();
      return;
    }
    if (phase !== 'reset') return;
    if (password !== confirmPassword) {
      setError(t('auth.forgot.passwordMismatch'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await authClient.emailOtp.resetPassword({
        email,
        otp: otp.trim(),
        password,
      });
      if (result.error) throw new Error(result.error.message || t('auth.forgot.resetFailed'));
      setPhase('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.forgot.resetFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="si-form" onSubmit={submit}>
      <div className="si-kicker">
        <span className="si-kicker-dot"></span>
        <span>{t('auth.forgot.kicker')}</span>
      </div>
      <h2 className="si-form__title">
        <em>{t('auth.forgot.titleEm')}</em>
        {t('auth.forgot.titleRest')}
      </h2>
      <p className="si-form__sub">
        {phase === 'email'
          ? t('auth.forgot.sub')
          : phase === 'reset'
            ? t('auth.forgot.codeSub', { email })
            : t('auth.forgot.done')}
      </p>

      {phase === 'email' && (
        <div className="si-field">
          <span className="si-field__k">{t('auth.fields.email')}</span>
          <input
            className="si-field__input"
            type="email"
            placeholder={t('auth.fields.emailPlaceholder')}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
            required
          />
        </div>
      )}

      {phase === 'reset' && (
        <>
          <div className="si-field">
            <span className="si-field__k">{t('auth.fields.code')}</span>
            <input
              className="si-field__input"
              inputMode="numeric"
              maxLength={6}
              placeholder={t('auth.fields.codePlaceholder')}
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              autoFocus
              required
            />
          </div>
          <div className="si-field">
            <span className="si-field__k">{t('auth.forgot.newPassword')}</span>
            <input
              className="si-field__input"
              type="password"
              minLength={10}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <div className="si-field">
            <span className="si-field__k">{t('auth.forgot.confirmPassword')}</span>
            <input
              className="si-field__input"
              type="password"
              minLength={10}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
            />
          </div>
        </>
      )}

      {error && <div className="si-error">{error}</div>}

      {phase !== 'done' && (
        <button
          type="submit"
          className="si-submit"
          disabled={busy || (phase === 'reset' && (otp.length !== 6 || password.length < 10))}
        >
          <span className="si-submit__cn">{t('auth.forgot.submit')}</span>
          <span>
            {busy
              ? t('auth.forgot.working')
              : phase === 'email'
                ? t('auth.forgot.submitShort')
                : t('auth.forgot.resetSubmit')}
          </span>
          <span className="si-submit__arrow">→</span>
        </button>
      )}

      {phase === 'reset' && (
        <button
          type="button"
          className="si-link-btn"
          onClick={() => void sendCode()}
          disabled={busy}
        >
          {t('auth.forgot.resend')}
        </button>
      )}

      <div className="si-foot-right">
        <a onClick={onCancel}>← {t('auth.backToSignIn')}</a>
      </div>
    </form>
  );
};

const OtpForm = ({
  initialEmail,
  onCancel,
  onSuccess,
}: {
  initialEmail?: string;
  onCancel: () => void;
  onSuccess: () => void | Promise<void>;
}) => {
  const { t } = useTranslation();
  const [stage, setStage] = useState<'enter-email' | 'enter-code'>('enter-email');
  const [email, setEmail] = useState(initialEmail ?? '');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendCode = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await authClient.emailOtp.sendVerificationOtp({ email, type: 'sign-in' });
      if (res.error) throw new Error(res.error.message || t('auth.errors.sendFailed'));
      setStage('enter-code');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.errors.sendRetry'));
    } finally {
      setBusy(false);
    }
  };

  const verifyCode = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await authClient.signIn.emailOtp({ email, otp });
      if (res.error) throw new Error(res.error.message || t('auth.errors.verifyFailed'));
      await onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.errors.verifyFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="si-form" onSubmit={stage === 'enter-email' ? sendCode : verifyCode}>
      <div className="si-kicker">
        <span className="si-kicker-dot"></span>
        <span>{t('auth.otp.kicker')}</span>
      </div>
      <h2 className="si-form__title">
        <em>{t('auth.otp.titleEm')}</em>
        {t('auth.otp.titleRest')}
      </h2>
      <p className="si-form__sub">
        {stage === 'enter-email' ? t('auth.otp.emailSub') : t('auth.otp.codeSub', { email })}
      </p>

      {error && <div className="si-error">{error}</div>}

      {stage === 'enter-email' ? (
        <div className="si-field">
          <span className="si-field__k">{t('auth.fields.email')}</span>
          <input
            className="si-field__input"
            type="email"
            placeholder={t('auth.fields.emailPlaceholder')}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
            autoFocus
            required
          />
        </div>
      ) : (
        <div className="si-field">
          <span className="si-field__k">{t('auth.fields.code')}</span>
          <input
            className="si-field__input set-input--mono"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            placeholder={t('auth.fields.codePlaceholder')}
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
            disabled={busy}
            autoFocus
            required
          />
        </div>
      )}

      <button type="submit" className="si-submit" disabled={busy}>
        <span className="si-submit__cn">
          {busy
            ? t('common.processing')
            : stage === 'enter-email'
              ? t('auth.sendCode')
              : t('auth.signIn')}
        </span>
        <span>{stage === 'enter-email' ? t('auth.sendCodeShort') : t('auth.signInShort')}</span>
        <span className="si-submit__arrow">→</span>
      </button>

      <div className="si-foot-right">
        {stage === 'enter-code' && (
          <>
            <a onClick={() => setStage('enter-email')}>← {t('auth.changeEmail')}</a>
            <span style={{ margin: '0 8px' }}>·</span>
          </>
        )}
        <a onClick={onCancel}>← {t('auth.backToPasswordSignIn')}</a>
      </div>
    </form>
  );
};

// Post-signup (or signin-blocked-by-unverified) gate. Auto-sends an
// email-verification OTP on mount; on submit it verifies the OTP then signs
// the user in with the password they just typed.
const VerifyAfterSignupForm = ({
  email,
  password,
  onCancel,
  onSuccess,
}: {
  email: string;
  password: string;
  onCancel: () => void;
  onSuccess: () => void | Promise<void>;
}) => {
  const { t } = useTranslation();
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentOnce, setSentOnce] = useState(false);

  const sendOtp = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await authClient.emailOtp.sendVerificationOtp({
        email,
        type: 'email-verification',
      });
      if (res.error) throw new Error(res.error.message || t('auth.errors.sendFailed'));
      setSentOnce(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.errors.sendCodeFailed'));
    } finally {
      setBusy(false);
    }
  };

  // Fire-and-forget on mount, exactly once per email. The ref guard survives
  // StrictMode's dev-only double-invoke of mount effects (setup→cleanup→setup
  // on the same instance keeps the ref) so the user gets ONE code, not two.
  // The resend button covers recovery if they navigate away and back.
  const sentForEmailRef = useRef<string | null>(null);
  useEffect(() => {
    if (!email || sentForEmailRef.current === email) return;
    sentForEmailRef.current = email;
    void sendOtp();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email]);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const verify = await authClient.emailOtp.verifyEmail({ email, otp });
      if (verify.error) throw new Error(verify.error.message || t('auth.errors.verifyFailed'));
      // Email is verified — now we can actually sign in with the password.
      const signIn = await authClient.signIn.email({ email, password });
      if (signIn.error) throw new Error(signIn.error.message || t('auth.errors.signInFailed'));
      await onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.errors.verifyFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="si-form" onSubmit={submit}>
      <div className="si-kicker">
        <span className="si-kicker-dot"></span>
        <span>{t('auth.verify.kicker')}</span>
      </div>
      <h2 className="si-form__title">
        <em>{t('auth.verify.titleEm')}</em>
        {t('auth.verify.titleRest')}
      </h2>
      <p className="si-form__sub">
        {sentOnce ? t('auth.verify.sent', { email }) : t('auth.verify.sending', { email })}
      </p>

      {error && <div className="si-error">{error}</div>}

      <div className="si-field">
        <span className="si-field__k">{t('auth.fields.code')}</span>
        <input
          className="si-field__input set-input--mono"
          inputMode="numeric"
          pattern="[0-9]{6}"
          maxLength={6}
          placeholder={t('auth.fields.codePlaceholder')}
          value={otp}
          onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
          disabled={busy}
          autoFocus
          required
        />
      </div>

      <button type="submit" className="si-submit" disabled={busy || otp.length !== 6}>
        <span className="si-submit__cn">
          {busy ? t('auth.verify.verifying') : t('auth.verify.submit')}
        </span>
        <span>{t('auth.verify.submitShort')}</span>
        <span className="si-submit__arrow">→</span>
      </button>

      <div className="si-foot-right">
        <a onClick={() => void sendOtp()}>{t('auth.resend')} →</a>
        <span style={{ margin: '0 8px' }}>·</span>
        <a onClick={onCancel}>← {t('auth.backToSignIn')}</a>
      </div>
    </form>
  );
};
