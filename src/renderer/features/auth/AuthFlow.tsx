import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Loader2, X } from 'lucide-react';
import { finishHostedSignIn } from '../../sync/hosted/sign-in';
import { authClient } from '../../lib/auth-client';
import { setSessionToken } from '../../lib/session-token';
import { platform } from '../../platform';
import { OAUTH_PROVIDER_CONFIG, OAUTH_PROVIDERS, type SupportedOAuthProvider } from '../../lib/oauth-providers';
import { isAppClosedForPublic } from '../../utils/appAccess';
import { APP_CONFIG } from '../../lib/config';
import { GhostIconButton } from '../../components/ui/GhostIconButton';
import type { AuthEntryMode } from './auth-dialog-store';
import '../../../styles/auth.css';

// Social sign-in is OFF for the BYOK-only beta: Google OAuth still injects a
// cookie that the bearer-token flow does not use. The block stays behind this
// flag for a proper pass later. Typed `boolean` (not literal false) so the
// gated JSX still type-checks and its handlers don't read as dead code.
const SOCIAL_LOGIN_ENABLED: boolean = false;

type Step = AuthEntryMode | 'otp' | 'forgot' | 'verify' | 'syncing';

interface AuthFlowProps {
  initialMode?: AuthEntryMode;
  /**
   * Called when sign-in and the initial library connection finish, or when the
   * author leaves a failed connection to retry later from Account settings.
   */
  onComplete(): void;
  /** Leaves the flow from its entry step, e.g. back to the first-run choice. */
  onBack?: () => void;
  onClose?: () => void;
  /** True while the library connection runs and the flow must stay open. */
  onLockedChange?: (locked: boolean) => void;
  presentation?: 'dialog' | 'page';
}

export function AuthFlow({
  initialMode = 'signin',
  onComplete,
  onBack,
  onClose,
  onLockedChange,
  presentation = 'dialog',
}: AuthFlowProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [oauthLoading, setOauthLoading] = useState<SupportedOAuthProvider | null>(null);
  const operation = useRef<AbortController | null>(null);
  const onCompleteRef = useRef(onComplete);
  useLayoutEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);
  useEffect(() => () => operation.current?.abort(), []);

  const locked = step === 'syncing' && !syncError;
  useEffect(() => {
    onLockedChange?.(locked);
  }, [locked, onLockedChange]);

  const go = (next: Step) => {
    setStep(next);
    setError(null);
  };

  // The account is verified at this point; connecting the library downloads
  // its cloud projects and uploads this library. Failures stay retryable.
  const connect = useCallback(async () => {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setStep('syncing');
    setSyncError(null);
    try {
      await finishHostedSignIn(controller.signal);
      if (!controller.signal.aborted) onCompleteRef.current();
    } catch (err) {
      if (!controller.signal.aborted)
        setSyncError(err instanceof Error ? err.message : t('auth.errors.sessionFailed'));
    }
  }, [t]);

  useEffect(
    () =>
      platform.auth.onOAuthCallback(({ token, error: callbackError }) => {
        setOauthLoading(null);
        if (callbackError || !token) {
          setError(t('auth.errors.oauthFailed'));
          return;
        }
        setSessionToken(token);
        void connect();
      }),
    [connect, t],
  );

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

  const submitCredentials = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (step === 'signup' && isAppClosedForPublic) {
      setError(t('auth.errors.signupClosed'));
      return;
    }
    setBusy(true);
    try {
      if (step === 'signin') {
        const result = await authClient.signIn.email({ email, password });
        if (result.error) {
          // requireEmailVerification rejects unverified accounts; drive them
          // through the code step instead of just reporting a failure.
          const { code, status } = result.error as { code?: string; status?: number };
          if (code === 'EMAIL_NOT_VERIFIED' || status === 403) {
            go('verify');
            return;
          }
          throw new Error(result.error.message || t('auth.errors.signInFailed'));
        }
        void connect();
      } else {
        // The server creates the account without a session until the email is
        // verified; the verify step then signs in with these credentials.
        const result = await authClient.signUp.email({ email, password, name });
        if (result.error) throw new Error(result.error.message || t('auth.errors.signUpFailed'));
        go('verify');
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t(step === 'signin' ? 'auth.errors.signInCheck' : 'auth.errors.signUpRetry'),
      );
    } finally {
      setBusy(false);
    }
  };

  const titles: Record<Step, string> = {
    signin: t('auth.titles.signin'),
    signup: t('auth.titles.signup'),
    otp: t('auth.titles.otp'),
    forgot: t('auth.titles.forgot'),
    verify: t('auth.titles.verify'),
    syncing: t(syncError ? 'auth.sync.failedTitle' : 'auth.sync.title'),
  };
  const back =
    step === 'otp' || step === 'forgot' || step === 'verify'
      ? () => go('signin')
      : step === 'syncing'
        ? undefined
        : onBack;

  let body: ReactNode;
  if (step === 'syncing') {
    body = syncError ? (
      <div className="auth-flow__body" role="alert">
        <p className="auth-flow__error">{syncError}</p>
        <p className="auth-flow__lead">{t('auth.sync.failedDetail')}</p>
        <div className="auth-flow__actions">
          <button type="button" className="auth-flow__button" onClick={() => onCompleteRef.current()}>
            {t('auth.sync.later')}
          </button>
          <button
            type="button"
            className="auth-flow__button auth-flow__button--primary"
            onClick={() => void connect()}
          >
            {t('auth.sync.retry')}
          </button>
        </div>
      </div>
    ) : (
      <div className="auth-flow__body auth-flow__progress" role="status" aria-live="polite">
        <Loader2 className="control-spinner" aria-hidden />
        <p className="auth-flow__lead">{t('auth.sync.detail')}</p>
      </div>
    );
  } else if (step === 'otp') {
    body = <OtpForm initialEmail={email} onSignedIn={connect} />;
  } else if (step === 'forgot') {
    body = <ForgotForm initialEmail={email} onDone={() => go('signin')} />;
  } else if (step === 'verify') {
    body = <VerifyForm email={email} password={password} onSignedIn={connect} />;
  } else {
    const signin = step === 'signin';
    body = (
      <form className="auth-flow__body" onSubmit={submitCredentials}>
        {signin && <p className="auth-flow__lead">{t('settings.hosted.sign_in_sync_description')}</p>}
        {error && (
          <p className="auth-flow__error" role="alert">
            {error}
          </p>
        )}
        {!signin && (
          <AuthField
            label={t('auth.fields.penName')}
            placeholder={t('auth.fields.penNamePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            required
            autoComplete="name"
            autoFocus
          />
        )}
        <AuthField
          label={t('auth.fields.email')}
          type="email"
          placeholder={t('auth.fields.emailPlaceholder')}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
          required
          autoComplete="email"
          autoFocus={signin}
        />
        <AuthField
          label={t('auth.fields.password')}
          aside={
            signin && (
              <button type="button" className="auth-flow__link" onClick={() => go('forgot')}>
                {t('auth.forgotPassword')}
              </button>
            )
          }
          type="password"
          placeholder={signin ? undefined : t('auth.fields.passwordSignupPlaceholder')}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
          required
          autoComplete={signin ? 'current-password' : 'new-password'}
          minLength={signin ? undefined : 10}
        />
        <button
          type="submit"
          className="auth-flow__button auth-flow__button--primary auth-flow__button--block"
          disabled={busy}
        >
          {busy
            ? t(signin ? 'auth.signingIn' : 'auth.creating')
            : t(signin ? 'auth.signIn' : 'auth.createAccount')}
        </button>
        {signin && (
          <button type="button" className="auth-flow__link auth-flow__link--center" onClick={() => go('otp')}>
            {t('auth.useOtp')}
          </button>
        )}
        {!signin && (
          <p className="auth-flow__legal">
            {t('auth.legal.agree')}{' '}
            <a
              onClick={() =>
                APP_CONFIG.TERMS_URL ? void platform.material.openExternal(APP_CONFIG.TERMS_URL) : undefined
              }
              aria-disabled={!APP_CONFIG.TERMS_URL}
              title={APP_CONFIG.TERMS_URL ? undefined : t('auth.legal.termsUnavailable')}
            >
              {t('auth.legal.terms')}
            </a>{' '}
            {t('auth.legal.and')}{' '}
            <a onClick={() => void platform.material.openExternal(APP_CONFIG.PRIVACY_URL)}>
              {t('auth.legal.privacy')}
            </a>
          </p>
        )}
        {SOCIAL_LOGIN_ENABLED && (
          <div className="auth-flow__social">
            {OAUTH_PROVIDERS.map((provider) => {
              const { name: providerName, Icon } = OAUTH_PROVIDER_CONFIG[provider];
              return (
                <button
                  key={provider}
                  type="button"
                  className="auth-flow__button auth-flow__button--block"
                  onClick={() => void handleOAuth(provider)}
                  disabled={busy || oauthLoading !== null}
                >
                  <Icon width={14} height={14} aria-hidden />
                  {oauthLoading === provider
                    ? t('auth.social.waiting')
                    : t('auth.social.continueWith', { provider: providerName })}
                </button>
              );
            })}
          </div>
        )}
      </form>
    );
  }

  return (
    <div className={`auth-flow auth-flow--${presentation}`}>
      <header className="auth-flow__head">
        {back && (
          <GhostIconButton
            className="auth-flow__back"
            icon={<ArrowLeft size={16} strokeWidth={1.6} />}
            onClick={back}
            title={t('auth.back')}
            aria-label={t('auth.back')}
          />
        )}
        <h2 className="auth-flow__title">{titles[step]}</h2>
        {onClose && !locked && (
          <GhostIconButton
            className="auth-flow__close"
            icon={<X size={16} strokeWidth={1.6} />}
            onClick={onClose}
            title={t('common.close')}
            aria-label={t('common.close')}
          />
        )}
      </header>
      {body}
      {(step === 'signin' || step === 'signup') && (
        <footer className="auth-flow__foot">
          <span>{t(step === 'signin' ? 'auth.noAccount' : 'auth.hasAccount')}</span>
          <button
            type="button"
            className="auth-flow__link"
            onClick={() => go(step === 'signin' ? 'signup' : 'signin')}
          >
            {t(step === 'signin' ? 'auth.signUp' : 'auth.signIn')}
          </button>
        </footer>
      )}
    </div>
  );
}

function AuthField({
  label,
  aside,
  className = '',
  ...input
}: { label: string; aside?: ReactNode } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <div className="auth-flow__field">
      <div className="auth-flow__label-row">
        <label className="auth-flow__label" htmlFor={id}>
          {label}
        </label>
        {aside}
      </div>
      <input id={id} className={`auth-flow__input ${className}`.trim()} {...input} />
    </div>
  );
}

function CodeField({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <AuthField
      label={t('auth.fields.code')}
      className="auth-flow__input--code"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]{6}"
      maxLength={6}
      placeholder={t('auth.fields.codePlaceholder')}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
      disabled={disabled}
      autoFocus
      required
    />
  );
}

function OtpForm({
  initialEmail,
  onSignedIn,
}: {
  initialEmail: string;
  onSignedIn: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [stage, setStage] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState(initialEmail);
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (stage === 'email') {
        const res = await authClient.emailOtp.sendVerificationOtp({ email, type: 'sign-in' });
        if (res.error) throw new Error(res.error.message || t('auth.errors.sendFailed'));
        setStage('code');
      } else {
        const res = await authClient.signIn.emailOtp({ email, otp });
        if (res.error) throw new Error(res.error.message || t('auth.errors.verifyFailed'));
        void onSignedIn();
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t(stage === 'email' ? 'auth.errors.sendRetry' : 'auth.errors.verifyFailed'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="auth-flow__body" onSubmit={submit}>
      <p className="auth-flow__lead">
        {stage === 'email' ? t('auth.otp.emailSub') : t('auth.otp.codeSub', { email })}
      </p>
      {error && (
        <p className="auth-flow__error" role="alert">
          {error}
        </p>
      )}
      {stage === 'email' ? (
        <AuthField
          label={t('auth.fields.email')}
          type="email"
          placeholder={t('auth.fields.emailPlaceholder')}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
          autoComplete="email"
          autoFocus
          required
        />
      ) : (
        <CodeField value={otp} onChange={setOtp} disabled={busy} />
      )}
      <button
        type="submit"
        className="auth-flow__button auth-flow__button--primary auth-flow__button--block"
        disabled={busy || (stage === 'code' && otp.length !== 6)}
      >
        {busy ? t('common.processing') : t(stage === 'email' ? 'auth.sendCode' : 'auth.signIn')}
      </button>
      {stage === 'code' && (
        <button
          type="button"
          className="auth-flow__link auth-flow__link--center"
          onClick={() => setStage('email')}
        >
          {t('auth.changeEmail')}
        </button>
      )}
    </form>
  );
}

function ForgotForm({ initialEmail, onDone }: { initialEmail: string; onDone(): void }) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<'email' | 'reset' | 'done'>('email');
  const [email, setEmail] = useState(initialEmail);
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

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (phase === 'done') {
      onDone();
      return;
    }
    if (phase === 'email') {
      await sendCode();
      return;
    }
    if (password !== confirmPassword) {
      setError(t('auth.forgot.passwordMismatch'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await authClient.emailOtp.resetPassword({ email, otp: otp.trim(), password });
      if (result.error) throw new Error(result.error.message || t('auth.forgot.resetFailed'));
      setPhase('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.forgot.resetFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="auth-flow__body" onSubmit={submit}>
      <p className="auth-flow__lead">
        {phase === 'email'
          ? t('auth.forgot.sub')
          : phase === 'reset'
            ? t('auth.forgot.codeSub', { email })
            : t('auth.forgot.done')}
      </p>
      {error && (
        <p className="auth-flow__error" role="alert">
          {error}
        </p>
      )}
      {phase === 'email' && (
        <AuthField
          label={t('auth.fields.email')}
          type="email"
          placeholder={t('auth.fields.emailPlaceholder')}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
          autoComplete="email"
          autoFocus
          required
        />
      )}
      {phase === 'reset' && (
        <>
          <CodeField value={otp} onChange={setOtp} disabled={busy} />
          <AuthField
            label={t('auth.forgot.newPassword')}
            type="password"
            placeholder={t('auth.fields.passwordSignupPlaceholder')}
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            autoComplete="new-password"
            required
          />
          <AuthField
            label={t('auth.forgot.confirmPassword')}
            type="password"
            minLength={10}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            disabled={busy}
            autoComplete="new-password"
            required
          />
        </>
      )}
      <button
        type="submit"
        className="auth-flow__button auth-flow__button--primary auth-flow__button--block"
        disabled={busy || (phase === 'reset' && (otp.length !== 6 || password.length < 10))}
      >
        {busy
          ? t('common.processing')
          : phase === 'email'
            ? t('auth.sendCode')
            : phase === 'reset'
              ? t('auth.forgot.resetSubmit')
              : t('auth.backToSignIn')}
      </button>
      {phase === 'reset' && (
        <button
          type="button"
          className="auth-flow__link auth-flow__link--center"
          onClick={() => void sendCode()}
          disabled={busy}
        >
          {t('auth.resend')}
        </button>
      )}
    </form>
  );
}

// Post-signup (or sign-in blocked as unverified) gate. Sends an
// email-verification code on mount, verifies it, then signs in with the
// password the author just typed.
function VerifyForm({
  email,
  password,
  onSignedIn,
}: {
  email: string;
  password: string;
  onSignedIn: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentOnce, setSentOnce] = useState(false);

  const sendOtp = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await authClient.emailOtp.sendVerificationOtp({ email, type: 'email-verification' });
      if (res.error) throw new Error(res.error.message || t('auth.errors.sendFailed'));
      setSentOnce(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.errors.sendCodeFailed'));
    } finally {
      setBusy(false);
    }
  };

  // Send once per email. The ref survives StrictMode's dev-only double mount
  // so the author gets one code, not two; "Resend" covers recovery.
  const sentForEmailRef = useRef<string | null>(null);
  useEffect(() => {
    if (!email || sentForEmailRef.current === email) return;
    sentForEmailRef.current = email;
    void sendOtp();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const verify = await authClient.emailOtp.verifyEmail({ email, otp });
      if (verify.error) throw new Error(verify.error.message || t('auth.errors.verifyFailed'));
      const signIn = await authClient.signIn.email({ email, password });
      if (signIn.error) throw new Error(signIn.error.message || t('auth.errors.signInFailed'));
      void onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.errors.verifyFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="auth-flow__body" onSubmit={submit}>
      <p className="auth-flow__lead">
        {sentOnce ? t('auth.verify.sent', { email }) : t('auth.verify.sending', { email })}
      </p>
      {error && (
        <p className="auth-flow__error" role="alert">
          {error}
        </p>
      )}
      <CodeField value={otp} onChange={setOtp} disabled={busy} />
      <button
        type="submit"
        className="auth-flow__button auth-flow__button--primary auth-flow__button--block"
        disabled={busy || otp.length !== 6}
      >
        {busy ? t('auth.verify.verifying') : t('auth.verify.submit')}
      </button>
      <button
        type="button"
        className="auth-flow__link auth-flow__link--center"
        onClick={() => void sendOtp()}
        disabled={busy}
      >
        {t('auth.resend')}
      </button>
    </form>
  );
}
