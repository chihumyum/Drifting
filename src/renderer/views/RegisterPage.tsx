import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Loader2, NotebookPen, Sparkles, UserRound, Mail, Lock } from 'lucide-react';
import { useAuthStore } from '../store/auth';
import { AuthLayout } from '../components/auth/AuthLayout';
import { BetaClosedDialog } from '../components/auth/BetaClosedDialog';
import { APP_CLOSED_MESSAGE, isAppClosedForPublic } from '../utils/appAccess';

const heroFeatures = [
  {
    title: '角色卡片系统',
    description: '在一个视图里管理角色设定、动机与发展轨迹。',
    icon: <UserRound className="h-5 w-5" />,
  },
  {
    title: '多维灵感库',
    description: '将场景、灵感与章节绑定，不再担心创作碎片遗失。',
    icon: <NotebookPen className="h-5 w-5" />,
  },
];

export function RegisterPage() {
  const navigate = useNavigate();
  const register = useAuthStore((state) => state.register);

  const [formData, setFormData] = useState({
    email: '',
    password: '',
    name: '',
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(
    isAppClosedForPublic ? APP_CLOSED_MESSAGE : null,
  );
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
      await register(formData.email, formData.password, formData.name);
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : '注册失败，请稍后重试');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthLayout
      heroEyebrow="Invite-Only Beta"
      heroTitle="组建属于你的世界观，"
      heroHighlight="从注册开始"
      heroSubtitle="登记信息后，我们将在开放新一轮内测时第一时间与您联系。"
      features={heroFeatures}
    >
      <div className="space-y-8">
        <div className="space-y-3 text-center">
          <div className="inline-flex items-center gap-2 rounded-full bg-[#f2e7d7] px-3 py-1 text-xs font-semibold text-[#8b6f47]">
            <Sparkles className="h-3.5 w-3.5" />
            Beta is coming soon!
          </div>
          <div>
            <h2 className="text-2xl font-semibold text-slate-900">注册 Drifting</h2>
            <p className="mt-1 text-sm text-slate-500">填写基本信息，开启多维写作体验。</p>
          </div>
        </div>

        {error && (
          <div className="rounded-2xl border border-[#f97316]/30 bg-[#fff1e6] px-4 py-3 text-sm text-[#9a4a1c]">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-2">
            <label
              htmlFor="name"
              className="text-xs font-semibold uppercase tracking-wide text-slate-500"
            >
              昵称
            </label>
            <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm focus-within:border-[#b89968] focus-within:ring-2 focus-within:ring-[#b89968]/30">
              <UserRound className="h-4 w-4 text-slate-400" />
              <input
                id="name"
                type="text"
                placeholder="创作者昵称"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                required
                disabled={isLoading}
                className="h-6 w-full border-none bg-transparent text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none disabled:text-slate-400"
              />
            </div>
          </div>

          <div className="space-y-2">
            <label
              htmlFor="email"
              className="text-xs font-semibold uppercase tracking-wide text-slate-500"
            >
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
            <label
              htmlFor="password"
              className="text-xs font-semibold uppercase tracking-wide text-slate-500"
            >
              密码
            </label>
            <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm focus-within:border-[#b89968] focus-within:ring-2 focus-within:ring-[#b89968]/30">
              <Lock className="h-4 w-4 text-slate-400" />
              <input
                id="password"
                type="password"
                placeholder="至少 8 位密码"
                value={formData.password}
                onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                required
                minLength={6}
                disabled={isLoading}
                className="h-6 w-full border-none bg-transparent text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none disabled:text-slate-400"
              />
            </div>
            <p className="text-xs text-slate-400">密码至少需要 8 个字符。</p>
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#b89968] px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-[#b89968]/40 transition hover:bg-[#a68858] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> 注册中...
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" /> 注册
              </>
            )}
          </button>
        </form>

        <div className="space-y-4 text-center text-sm text-slate-500">
          <p>
            已有账户？{' '}
            <Link to="/login" className="font-semibold text-[#8b6f47] hover:text-[#b89968]">
              立即登录
            </Link>
          </p>
          <a
            href="https://app.drifting.cc"
            className="inline-flex items-center justify-center gap-2 rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold uppercase tracking-widest text-slate-500 transition hover:border-[#b89968] hover:text-[#8b6f47]"
          >
            了解内测计划
            <Sparkles className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>
      <BetaClosedDialog open={showClosedDialog} onClose={() => setShowClosedDialog(false)} />
    </AuthLayout>
  );
}
