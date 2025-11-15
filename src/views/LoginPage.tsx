import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Mail, Lock, Loader2, LogIn, Sparkles, NotebookPen } from 'lucide-react';
import { useAuthStore } from '../store/auth';
import { AuthLayout } from '../components/auth/AuthLayout';
import { BetaClosedDialog } from '../components/auth/BetaClosedDialog';
import { APP_CLOSED_MESSAGE, isAppClosedForPublic } from '../utils/appAccess';

const heroFeatures = [
  {
    title: '章节时间线',
    description: '通过时间轴快速梳理章节节奏，让长篇创作更加有序。',
    icon: <Sparkles className="h-5 w-5" />, 
  },
  {
    title: '灵感卡片',
    description: '随手记录角色或事件灵感，自动归档到对应节点。',
    icon: <NotebookPen className="h-5 w-5" />,
  },
];

function buildGoogleOAuthUrl() {
  const base = (import.meta.env.VITE_API_URL as string | undefined) || window.location.origin;
  return `${base.replace(/\/$/, '')}/api/auth/google`;
}

function buildWeChatOAuthUrl() {
  const base = (import.meta.env.VITE_API_URL as string | undefined) || window.location.origin;
  return `${base.replace(/\/$/, '')}/api/auth/wechat`;
}

function GoogleIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 10.8v3.84h5.45c-.24 1.34-.98 2.48-2.1 3.24l3.4 2.63c1.98-1.83 3.12-4.53 3.12-7.71 0-.74-.07-1.46-.2-2.16H12Z"
        fill="#4285F4"
      />
      <path
        d="M5.3 14.32 4.42 15 1.7 17.12C3.41 20.52 6.45 23 12 23c3.24 0 5.95-1.07 7.93-2.89l-3.4-2.63c-.94.63-2.14 1.08-3.53 1.08-2.72 0-5.02-1.83-5.84-4.3Z"
        fill="#34A853"
      />
      <path
        d="M1.7 6.88C.93 8.27.5 9.86.5 11.5s.43 3.23 1.2 4.62c0 0 3.11-2.42 3.84-2.96-.22-.66-.34-1.36-.34-2.09s.13-1.43.34-2.09Z"
        fill="#FBBC05"
      />
      <path
        d="M12 4.96c1.76 0 3.31.6 4.54 1.78l3.4-3.4C17.96 1.18 15.24 0 12 0 6.45 0 3.41 2.48 1.7 5.88l3.68 2.88C6.98 6.79 9.28 4.96 12 4.96Z"
        fill="#EA4335"
      />
    </svg>
  );
}

function WeChatIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M9.6 4C5.74 4 3 6.57 3 9.47c0 1.9 1.13 3.56 2.88 4.58-.1.36-.38 1.36-.44 1.63-.07.31.11.6.44.45.31-.14 1.76-1 2.06-1.17.52.08 1.06.12 1.62.12 3.86 0 6.6-2.57 6.6-5.47C16.16 6.57 13.46 4 9.6 4Zm-2 4.04c-.44 0-.8-.36-.8-.8 0-.45.36-.8.8-.8s.8.35.8.8c0 .44-.36.8-.8.8Zm4.4 0c-.44 0-.8-.36-.8-.8 0-.45.36-.8.8-.8s.8.35.8.8c0 .44-.36.8-.8.8Z"
        fill="#1AAD19"
      />
      <path
        d="M20.18 11.36c0-2.46-2.3-4.46-5.15-4.65a5.55 5.55 0 0 1 1.14 3.33c0 3.46-3.26 6.27-7.29 6.27-.2 0-.4-.01-.6-.02 1.02 2.03 3.36 3.46 6.02 3.46.58 0 1.14-.06 1.68-.17.28.17 1.57.94 1.86 1.07.32.15.51-.14.44-.45-.06-.27-.34-1.27-.44-1.63 1.62-.98 2.34-2.5 2.34-4.21Zm-6.15 1.73c-.36 0-.66-.29-.66-.66 0-.36.3-.66.66-.66.37 0 .66.3.66.66 0 .37-.29.66-.66.66Zm3 0c-.36 0-.66-.29-.66-.66 0-.36.3-.66.66-.66.36 0 .66.3.66.66 0 .37-.3.66-.66.66Z"
        fill="#1AAD19"
      />
    </svg>
  );
}

export function LoginPage() {
  const navigate = useNavigate();
  const login = useAuthStore((state) => state.login);

  const [formData, setFormData] = useState({
    email: '',
    password: '',
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(isAppClosedForPublic ? APP_CLOSED_MESSAGE : null);
  const [showClosedDialog, setShowClosedDialog] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    if (isAppClosedForPublic) {
      setError(APP_CLOSED_MESSAGE);
      setShowClosedDialog(true);
      return;
    }

    setIsLoading(true);

    try {
      await login(formData);
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败，请检查您的邮箱和密码');
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogleLogin = () => {
    if (isAppClosedForPublic) {
      setError(APP_CLOSED_MESSAGE);
      setShowClosedDialog(true);
      return;
    }
    window.location.href = buildGoogleOAuthUrl();
  };

  const handleWeChatLogin = () => {
    if (isAppClosedForPublic) {
      setError(APP_CLOSED_MESSAGE);
      setShowClosedDialog(true);
      return;
    }
    window.location.href = buildWeChatOAuthUrl();
  };

  return (
    <AuthLayout
      heroEyebrow="Creator Private Beta"
      heroTitle="在灵感与结构之间，"
      heroHighlight="保持流动"
      heroSubtitle="Drifting 为长篇创作者打造的多维度写作工作室，集章节管理、灵感收集与协作于一体。"
      features={heroFeatures}
    >
      <div className="space-y-8">
        <div className="space-y-3 text-center">
          <div className="inline-flex items-center gap-2 rounded-full bg-[#f2e7d7] px-3 py-1 text-xs font-semibold text-[#8b6f47]">
            <Sparkles className="h-3.5 w-3.5" />
            Beta is coming soon!
          </div>
          <div>
            <h2 className="text-2xl font-semibold text-slate-900">登录 Drifting</h2>
            <p className="mt-1 text-sm text-slate-500">使用注册邮箱继续创作您的世界观。</p>
          </div>
        </div>

        {error && (
          <div className="rounded-2xl border border-[#f97316]/30 bg-[#fff1e6] px-4 py-3 text-sm text-[#9a4a1c]">
            {error}
          </div>
        )}

        <div className="space-y-3">
          <button
            type="button"
            onClick={handleGoogleLogin}
            className="flex w-full items-center justify-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 shadow-sm transition hover:border-[#b89968] hover:text-[#8b6f47]"
          >
            <GoogleIcon />
            使用 Google 登录
          </button>
          <button
            type="button"
            onClick={handleWeChatLogin}
            className="flex w-full items-center justify-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 shadow-sm transition hover:border-[#1AAD19]/60 hover:text-[#0f8b12]"
          >
            <WeChatIcon />
            使用微信登录
          </button>
        </div>

        <div className="flex items-center gap-3 text-xs uppercase tracking-widest text-slate-400">
          <span className="h-px flex-1 bg-slate-200" />
          或使用邮箱
          <span className="h-px flex-1 bg-slate-200" />
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-2">
            <label htmlFor="email" className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              邮箱
            </label>
            <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm focus-within:border-[#b89968] focus-within:ring-2 focus-within:ring-[#b89968]/30">
              <Mail className="h-4 w-4 text-slate-400" />
              <input
                id="email"
                type="email"
                placeholder="name@example.com"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                required
                disabled={isLoading}
                className="h-6 w-full border-none bg-transparent text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none disabled:text-slate-400"
              />
            </div>
          </div>

          <div className="space-y-2">
            <label htmlFor="password" className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              密码
            </label>
            <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm focus-within:border-[#b89968] focus-within:ring-2 focus-within:ring-[#b89968]/30">
              <Lock className="h-4 w-4 text-slate-400" />
              <input
                id="password"
                type="password"
                placeholder="••••••••"
                value={formData.password}
                onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                required
                disabled={isLoading}
                className="h-6 w-full border-none bg-transparent text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none disabled:text-slate-400"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#b89968] px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-[#b89968]/40 transition hover:bg-[#a68858] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> 登录中...
              </>
            ) : (
              <>
                <LogIn className="h-4 w-4" /> 登录
              </>
            )}
          </button>
        </form>

        <div className="space-y-4 text-center text-sm text-slate-500">
          <p>
            还没有账户？{' '}
            <Link to="/register" className="font-semibold text-[#8b6f47] hover:text-[#b89968]">
              立即注册
            </Link>
          </p>
          <a
            href="https://app.drifting.cc"
            className="inline-flex items-center justify-center gap-2 rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold uppercase tracking-widest text-slate-500 transition hover:border-[#b89968] hover:text-[#8b6f47]"
          >
            前往 app.drifting.cc 了解更多
            <LogIn className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>
      <BetaClosedDialog open={showClosedDialog} onClose={() => setShowClosedDialog(false)} />
    </AuthLayout>
  );
}
