import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import i18next from 'i18next';
import { describe, expect, it } from 'vitest';
import zhCN from '../../locales/zh-CN.json';
import en from '../../locales/en.json';
import { authErrorMessage } from './auth-errors';

async function translator(lng: 'zh-CN' | 'en') {
  const instance = i18next.createInstance();
  await instance.init({
    resources: { 'zh-CN': { translation: zhCN }, en: { translation: en } },
    lng,
    interpolation: { escapeValue: false },
    showSupportNotice: false,
  });
  return instance.t;
}

describe('auth errors when verification mail cannot go out', () => {
  it('explains a used-up day without an account being needed to write', async () => {
    const zh = await translator('zh-CN');
    const english = await translator('en');
    const quota = { code: 'MAIL_QUOTA_EXHAUSTED', message: "Today's verification mail is used up. Try again tomorrow." };

    expect(authErrorMessage(quota, zh, 'auth.errors.signUpFailed')).toBe(
      '今天的验证邮件已经发完了。Drifting 不登录也能完整写作，你可以先在本机写，明天再来登录并开启同步。',
    );
    expect(authErrorMessage(quota, english, 'auth.errors.signUpFailed')).toBe(
      "Today's verification emails have all been sent. Drifting works fully without an account, so keep writing on this device and come back tomorrow to sign in and turn on sync.",
    );
    const failed = { code: 'MAIL_DELIVERY_FAILED' };
    expect(authErrorMessage(failed, zh, 'auth.errors.sendFailed')).toMatch(/^验证邮件暂时发不出去。.*不登录也能完整写作.*本机.*同步/);
    expect(authErrorMessage(failed, english, 'auth.errors.sendFailed')).toMatch(
      /^Verification emails can't be sent right now\..*without an account.*this device.*sync/,
    );
    for (const message of [zh('auth.errors.mailQuotaExhausted'), english('auth.errors.mailQuotaExhausted')])
      expect(message).not.toMatch(/名额|quota|slots/i);
  });

  it('keeps the service message or the fallback for other failures', async () => {
    const zh = await translator('zh-CN');
    expect(authErrorMessage({ code: 'USER_ALREADY_EXISTS', message: 'User already exists' }, zh, 'auth.errors.signUpFailed')).toBe(
      'User already exists',
    );
    expect(authErrorMessage({}, zh, 'auth.errors.sendCodeFailed')).toBe('发送验证码失败');
  });

  it('is used wherever the flow asks the service to mail a code', () => {
    const flow = readFileSync(resolve(process.cwd(), 'src/renderer/features/auth/AuthFlow.tsx'), 'utf8');
    for (const request of [
      'authClient.signUp.email(',
      "authClient.emailOtp.sendVerificationOtp({ email, type: 'sign-in' })",
      'authClient.emailOtp.requestPasswordReset(',
      "authClient.emailOtp.sendVerificationOtp({ email, type: 'email-verification' })",
    ]) {
      const call = flow.indexOf(request);
      expect(call).toBeGreaterThan(-1);
      expect(flow.slice(call, flow.indexOf('\n', flow.indexOf('\n', call) + 1))).toContain('authErrorMessage(');
    }
  });
});
