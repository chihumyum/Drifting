import { Fragment, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/auth';
import { authClient } from '../lib/auth-client';
import type { SupportedOAuthProvider } from '../lib/oauth-providers';
import { APP_CLOSED_MESSAGE, isAppClosedForPublic } from '../utils/appAccess';
import { BetaClosedDialog } from '../components/auth/BetaClosedDialog';
import '../../styles/signin.css';

type Mode = 'signin' | 'signup' | 'forgot' | 'otp' | 'verifyAfterSignup';

interface SocialProvider {
  key: string;
  iconClass: string;
  icon: string;
  signInLabel: string;
  signUpLabel: string;
  sub: string;
  oauth?: SupportedOAuthProvider;
}

const SOCIAL_PROVIDERS: SocialProvider[] = [
  {
    key: 'google',
    iconClass: 'si-soc-btn__icon--g',
    icon: 'G',
    signInLabel: '用 Google 登录',
    signUpLabel: '用 Google 注册',
    sub: 'OAuth',
    oauth: 'google',
  },
  {
    key: 'apple',
    iconClass: 'si-soc-btn__icon--a',
    icon: '⌘',
    signInLabel: '用 Apple 登录',
    signUpLabel: '用 Apple 注册',
    sub: 'Sign in with Apple',
  },
  {
    key: 'wechat',
    iconClass: 'si-soc-btn__icon--w',
    icon: '微',
    signInLabel: '用微信登录',
    signUpLabel: '用微信注册',
    sub: 'WeChat',
  },
];

interface LoginPageProps {
  initialMode?: Exclude<Mode, 'forgot'>;
}

export function LoginPage({ initialMode = 'signin' }: LoginPageProps) {
  const navigate = useNavigate();
  const adoptSession = useAuthStore((state) => state.adoptSession);
  const checkSession = useAuthStore((state) => state.checkSession);

  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [remember, setRemember] = useState(true);
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
      setError(err instanceof Error ? err.message : '登录失败');
    }
  };

  useEffect(() => {
    const cleanup = window.electronAPI.auth.onOAuthCallback(
      async ({ token, error: callbackError }) => {
        setOauthLoading(null);
        if (callbackError || !token) {
          setError('OAuth 登录失败，请重试。');
          return;
        }
        try {
          await checkSession();
        } catch {
          setError('无法获取登录状态，请重试。');
        }
      },
    );
    return cleanup;
  }, [checkSession]);

  const handleOAuth = async (provider: SupportedOAuthProvider) => {
    setError(null);
    setOauthLoading(provider);
    try {
      await window.electronAPI.auth.openOAuthBrowser(provider);
    } catch {
      setError('无法打开浏览器，请重试。');
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
          throw new Error(result.error.message || '登录失败');
        }
        await adoptSession();
        navigate('/');
      } else {
        // Signup. With requireEmailVerification=true the server creates the
        // user without an active session. We keep the (email, password) in
        // state so the post-verify step can sign in cleanly.
        const result = await authClient.signUp.email({ email, password, name });
        if (result.error) {
          throw new Error(result.error.message || '注册失败');
        }
        setMode('verifyAfterSignup');
      }
    } catch (err) {
      const fallback = mode === 'signin' ? '登录失败，请检查邮箱和密码' : '注册失败，请稍后重试';
      setError(err instanceof Error ? err.message : fallback);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="signin">
      {/* ═══ Left · editorial / brand ═══ */}
      <aside className="si-left">
        <div className="si-brand">
          <span className="si-brand__glyph">渡</span>
          <span className="si-brand__name">Drifting</span>
          <span className="si-brand__sep">·</span>
          <span className="si-brand__cn">渡舟</span>
        </div>

        <div className="si-quote">
          <div className="si-quote__kicker">
            <span className="si-quote__kicker-dot"></span>
            <span>WRITING STUDIO</span>
            <span className="si-quote__kicker-sep">·</span>
            <span>FOR SERIOUS NOVELISTS</span>
          </div>
          <h1 className="si-quote__title">
            写作是一场<em>漫长的渡</em>。<br />
            这里给你一艘<em>足够稳的船</em>。
          </h1>
          <p className="si-quote__body">
            Drifting 把章节、故事线、人物、地点、物件、浮缀 — 你心里所有的卷宗 — 编织在一张可漫游的纸上。
          </p>

          <div className="si-feats">
            <div className="si-feat">
              <span className="si-feat__mark">§</span>
              <div className="si-feat__body">
                <span className="si-feat__title">
                  章节 · <em>scene & beat</em> 大纲
                </span>
                <span className="si-feat__sub">markdown header · scrollspy · 大纲即正文</span>
              </div>
            </div>
            <div className="si-feat">
              <span className="si-feat__mark">◆</span>
              <div className="si-feat__body">
                <span className="si-feat__title">元素 · 自定义类目 + 字段</span>
                <span className="si-feat__sub">人物 / 地点 / 物件 / 时代纪 / 语汇 / 你自己的</span>
              </div>
            </div>
            <div className="si-feat">
              <span className="si-feat__mark">¶</span>
              <div className="si-feat__body">
                <span className="si-feat__title">
                  故事线 · <em>多视角</em>叙事
                </span>
                <span className="si-feat__sub">时间轴 · 叙事弧 · 跨线索引</span>
              </div>
            </div>
            <div className="si-feat">
              <span className="si-feat__mark">◐</span>
              <div className="si-feat__body">
                <span className="si-feat__title">Shadow · 离线 AI 校读</span>
                <span className="si-feat__sub">人物年龄 / 视角越界 / 设定矛盾</span>
              </div>
            </div>
          </div>
        </div>

        <div className="si-foot">
          <span>Drifting Writing Studio · v3.2</span>
          <span className="si-foot__orn">⁂</span>
          <span>本地优先 · 端到端加密</span>
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
            <span className="si-tab__cn">登录</span>
            <span>SIGN IN</span>
          </button>
          <button
            type="button"
            className={`si-tab ${mode === 'signup' ? 'si-tab--active' : ''}`}
            onClick={() => switchMode('signup')}
          >
            <span className="si-tab__cn">注册</span>
            <span>SIGN UP</span>
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
              <span>{mode === 'signin' ? 'WELCOME BACK · 继续写作' : 'NEW HERE · 起航'}</span>
            </div>
            <h2 className="si-form__title">
              {mode === 'signin' ? (
                <Fragment>
                  <em>登录</em> Drifting
                </Fragment>
              ) : (
                <Fragment>
                  <em>新建</em>账号
                </Fragment>
              )}
            </h2>
            <p className="si-form__sub">
              {mode === 'signin'
                ? '回到你已经构建的世界 — 章节、故事线、元素、浮缀都还在。'
                : '注册一个账号，开始你的第一本书。我们不会把你的稿子用于任何模型训练。'}
            </p>

            {error && <div className="si-error">{error}</div>}

            {mode === 'signup' && (
              <div className="si-field">
                <span className="si-field__k">笔名 · PEN NAME</span>
                <input
                  className="si-field__input"
                  placeholder="例：望舒"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={isSubmitting}
                  required
                  autoFocus
                />
              </div>
            )}

            <div className="si-field">
              <span className="si-field__k">邮箱 · EMAIL</span>
              <input
                className="si-field__input"
                type="email"
                placeholder="your@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isSubmitting}
                required
                autoFocus={mode === 'signin'}
              />
            </div>

            <div className="si-field">
              <span className="si-field__k">
                密码 · PASSWORD
                {mode === 'signin' && (
                  <a onClick={() => switchMode('otp')}>用邮箱验证码 →</a>
                )}
              </span>
              <input
                className="si-field__input"
                type="password"
                placeholder={mode === 'signup' ? '至少 10 字符' : '••••••••'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isSubmitting}
                required
                minLength={mode === 'signup' ? 10 : undefined}
              />
            </div>

            {mode === 'signin' && (
              <div
                className={`si-remember ${remember ? 'si-remember--on' : ''}`}
                onClick={() => setRemember((v) => !v)}
              >
                <span className="si-remember__box"></span>
                <span>记住我 — 这台机器</span>
              </div>
            )}

            <button type="submit" className="si-submit" disabled={isSubmitting}>
              <span className="si-submit__cn">
                {isSubmitting
                  ? mode === 'signin'
                    ? '登录中…'
                    : '创建中…'
                  : mode === 'signin'
                  ? '登录'
                  : '创建账号'}
              </span>
              <span>{mode === 'signin' ? 'SIGN IN' : 'CREATE ACCOUNT'}</span>
              <span className="si-submit__arrow">→</span>
            </button>

            <div className="si-or">OR · 用第三方</div>

            <div className="si-social">
              {SOCIAL_PROVIDERS.map((p) => {
                const enabled = !!p.oauth;
                const loading = p.oauth && oauthLoading === p.oauth;
                return (
                  <button
                    key={p.key}
                    type="button"
                    className="si-soc-btn"
                    onClick={enabled ? () => handleOAuth(p.oauth as SupportedOAuthProvider) : undefined}
                    disabled={!enabled || isSubmitting || oauthLoading !== null}
                    title={enabled ? undefined : '即将开放'}
                  >
                    <span className={`si-soc-btn__icon ${p.iconClass}`}>{p.icon}</span>
                    <span className="si-soc-btn__label">
                      {loading
                        ? '等待浏览器授权…'
                        : mode === 'signin'
                        ? p.signInLabel
                        : p.signUpLabel}
                    </span>
                    <span className="si-soc-btn__sub">
                      {enabled ? p.sub : '即将开放'}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="si-foot-right">
              {mode === 'signin' ? (
                <Fragment>
                  <span>还没有账号？</span>
                  <a onClick={() => switchMode('signup')}>立即注册 →</a>
                </Fragment>
              ) : (
                <Fragment>
                  <span>已经有账号？</span>
                  <a onClick={() => switchMode('signin')}>登录 →</a>
                </Fragment>
              )}
            </div>

            <div className="si-legal">
              {mode === 'signup' && (
                <Fragment>
                  注册即代表你同意我们的 <a>服务条款</a> 与 <a>隐私政策</a>。<br />
                </Fragment>
              )}
              本地优先 · 端到端加密 · 不用作模型训练
            </div>
          </form>
        )}
      </main>

      <BetaClosedDialog open={showClosedDialog} onClose={() => setShowClosedDialog(false)} />
    </div>
  );
}

const ForgotForm = ({ onCancel }: { onCancel: () => void }) => {
  const [sent, setSent] = useState(false);
  const [email, setEmail] = useState('');

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    try {
      await authClient.emailOtp.sendVerificationOtp({ email, type: 'forget-password' });
      setSent(true);
    } catch {
      setSent(true);
    }
  };

  return (
    <form className="si-form" onSubmit={submit}>
      <div className="si-kicker">
        <span className="si-kicker-dot"></span>
        <span>RESET · 重置密码</span>
      </div>
      <h2 className="si-form__title">
        <em>找回</em>账号
      </h2>
      <p className="si-form__sub">填邮箱 — 我们寄一封带验证码的信去。</p>

      <div className="si-field">
        <span className="si-field__k">邮箱 · EMAIL</span>
        <input
          className="si-field__input"
          type="email"
          placeholder="your@email.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
          required
        />
      </div>

      {sent ? (
        <div className="si-sent">已寄出。请去 {email || '邮箱'} 查收。</div>
      ) : (
        <button type="submit" className="si-submit">
          <span className="si-submit__cn">寄出</span>
          <span>SEND CODE</span>
          <span className="si-submit__arrow">→</span>
        </button>
      )}

      <div className="si-foot-right">
        <a onClick={onCancel}>← 回到登录</a>
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
      if (res.error) throw new Error(res.error.message || '发送失败');
      setStage('enter-code');
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送失败，请稍后重试');
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
      if (res.error) throw new Error(res.error.message || '验证失败');
      await onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : '验证失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="si-form" onSubmit={stage === 'enter-email' ? sendCode : verifyCode}>
      <div className="si-kicker">
        <span className="si-kicker-dot"></span>
        <span>OTP · 邮箱验证码登录</span>
      </div>
      <h2 className="si-form__title">
        <em>无密码</em>登录
      </h2>
      <p className="si-form__sub">
        {stage === 'enter-email'
          ? '填邮箱 — 我们寄一个 6 位验证码，10 分钟内有效。'
          : `已寄到 ${email}。在 10 分钟内输入 6 位验证码。`}
      </p>

      {error && <div className="si-error">{error}</div>}

      {stage === 'enter-email' ? (
        <div className="si-field">
          <span className="si-field__k">邮箱 · EMAIL</span>
          <input
            className="si-field__input"
            type="email"
            placeholder="your@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
            autoFocus
            required
          />
        </div>
      ) : (
        <div className="si-field">
          <span className="si-field__k">验证码 · CODE</span>
          <input
            className="si-field__input set-input--mono"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            placeholder="6 位数字"
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
          {busy ? '处理中…' : stage === 'enter-email' ? '发送验证码' : '登录'}
        </span>
        <span>{stage === 'enter-email' ? 'SEND CODE' : 'SIGN IN'}</span>
        <span className="si-submit__arrow">→</span>
      </button>

      <div className="si-foot-right">
        {stage === 'enter-code' && (
          <>
            <a onClick={() => setStage('enter-email')}>← 改邮箱</a>
            <span style={{ margin: '0 8px' }}>·</span>
          </>
        )}
        <a onClick={onCancel}>← 回到密码登录</a>
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
      if (res.error) throw new Error(res.error.message || '发送失败');
      setSentOnce(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送验证码失败');
    } finally {
      setBusy(false);
    }
  };

  // Fire-and-forget on mount. If the user navigates away (cancel) and comes
  // back via the same email later, the resend button covers the recovery.
  useEffect(() => {
    if (!email) return;
    void sendOtp();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email]);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const verify = await authClient.emailOtp.verifyEmail({ email, otp });
      if (verify.error) throw new Error(verify.error.message || '验证失败');
      // Email is verified — now we can actually sign in with the password.
      const signIn = await authClient.signIn.email({ email, password });
      if (signIn.error) throw new Error(signIn.error.message || '登录失败');
      await onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : '验证失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="si-form" onSubmit={submit}>
      <div className="si-kicker">
        <span className="si-kicker-dot"></span>
        <span>VERIFY · 验证邮箱</span>
      </div>
      <h2 className="si-form__title">
        <em>确认</em>邮箱
      </h2>
      <p className="si-form__sub">
        {sentOnce
          ? `已寄到 ${email}。请在 10 分钟内输入 6 位验证码。`
          : `正在向 ${email} 发送验证码…`}
      </p>

      {error && <div className="si-error">{error}</div>}

      <div className="si-field">
        <span className="si-field__k">验证码 · CODE</span>
        <input
          className="si-field__input set-input--mono"
          inputMode="numeric"
          pattern="[0-9]{6}"
          maxLength={6}
          placeholder="6 位数字"
          value={otp}
          onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
          disabled={busy}
          autoFocus
          required
        />
      </div>

      <button type="submit" className="si-submit" disabled={busy || otp.length !== 6}>
        <span className="si-submit__cn">{busy ? '验证中…' : '验证并进入'}</span>
        <span>VERIFY</span>
        <span className="si-submit__arrow">→</span>
      </button>

      <div className="si-foot-right">
        <a onClick={() => void sendOtp()}>重新发送 →</a>
        <span style={{ margin: '0 8px' }}>·</span>
        <a onClick={onCancel}>← 回到登录</a>
      </div>
    </form>
  );
};

