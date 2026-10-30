import { useState, type FormEvent } from 'react';
import { accountApi, ReaderError } from './api';
import { errorText, t } from './i18n';

type Step = 'sign-in' | 'sign-up' | 'verify';

/** Sign in, or sign up and verify the email, without leaving the page. */
export function AuthPanel({ onSignedIn }: { onSignedIn: () => void }) {
  const [step, setStep] = useState<Step>('sign-in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (event: FormEvent, work: () => Promise<void>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      const code = failure instanceof ReaderError ? failure.code : 'fallback';
      if (code === 'EMAIL_NOT_VERIFIED') {
        await accountApi.sendCode(email).catch(() => undefined);
        setStep('verify');
      } else {
        setError(errorText(code));
      }
    } finally {
      setBusy(false);
    }
  };

  const signIn = async () => {
    await accountApi.signIn(email.trim(), password);
    onSignedIn();
  };

  return (
    <div className="auth">
      <p className="auth__lead">{step === 'verify' ? t.codeSent(email.trim()) : t.signInToComment}</p>
      {step === 'verify' ? (
        <form className="auth__form" onSubmit={event => void run(event, async () => {
          await accountApi.verify(email.trim(), code.trim());
          await signIn();
        })}>
          <label className="field">
            <span>{t.code}</span>
            <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} required value={code} onChange={event => setCode(event.target.value)} />
          </label>
          {error && <p className="auth__error" role="alert">{error}</p>}
          <button type="submit" className="button button--primary" disabled={busy}>{t.verify}</button>
        </form>
      ) : (
        <form className="auth__form" onSubmit={event => void run(event, async () => {
          if (step === 'sign-up') {
            if (password.length < 8) throw new ReaderError('PASSWORD_TOO_SHORT', 400);
            await accountApi.signUp(name.trim(), email.trim(), password);
            await accountApi.sendCode(email.trim());
            setStep('verify');
            return;
          }
          await signIn();
        })}>
          {step === 'sign-up' && (
            <label className="field">
              <span>{t.name}</span>
              <input autoComplete="nickname" maxLength={80} required value={name} onChange={event => setName(event.target.value)} />
            </label>
          )}
          <label className="field">
            <span>{t.email}</span>
            <input type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} />
          </label>
          <label className="field">
            <span>{t.password}</span>
            <input type="password" autoComplete={step === 'sign-up' ? 'new-password' : 'current-password'} required value={password} onChange={event => setPassword(event.target.value)} />
          </label>
          {error && <p className="auth__error" role="alert">{error}</p>}
          <button type="submit" className="button button--primary" disabled={busy}>{step === 'sign-up' ? t.signUp : t.signIn}</button>
          <button type="button" className="button button--text" onClick={() => { setStep(step === 'sign-up' ? 'sign-in' : 'sign-up'); setError(null); }}>
            {step === 'sign-up' ? t.haveAccount : t.needAccount}
          </button>
        </form>
      )}
    </div>
  );
}
