import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Loader2, NotebookPen, Sparkles, UserRound, Mail, Lock } from 'lucide-react';
import { useAuthStore } from '../store/auth';
import { AuthLayout } from '../viewComponents/auth/AuthLayout';
import { OAuthButtons } from '../viewComponents/auth/OAuthButtons';

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

export function LoginPage() {
  const navigate = useNavigate();
  const login = useAuthStore((state) => state.login);

  const [formData, setFormData] = useState({
    email: '',
    password: '',
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      await login(formData.email, formData.password);
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败，请检查邮箱和密码');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthLayout
      heroEyebrow="Welcome Back"
      heroTitle="继续你的创作旅程"
      heroHighlight=""
      heroSubtitle="登录 Drifting，回到你构建的世界观。"
      features={heroFeatures}
    >
      <div className="space-y-8">
        <div className="space-y-3 text-center">
          <div className="inline-flex items-center gap-2 rounded-full bg-[#f2e7d7] px-3 py-1 text-xs font-semibold text-[#8b6f47]">
            <Sparkles className="h-3.5 w-3.5" />
            Continue your story
          </div>
          <div>
            <h2 className="text-2xl font-semibold text-slate-900">登录 Drifting</h2>
            <p className="mt-1 text-sm text-slate-500">使用邮箱和密码登录。</p>
          </div>
        </div>

        {error && (
          <div className="rounded-2xl border border-[#f97316]/30 bg-[#fff1e6] px-4 py-3 text-sm text-[#9a4a1c]">
            {error}
          </div>
        )}

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
                placeholder="your@email.com"
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
            className="w-full rounded-2xl bg-[#8b6f47] px-6 py-3.5 text-sm font-semibold text-white shadow-lg shadow-[#8b6f47]/20 transition-all hover:bg-[#b89968] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                登录中...
              </span>
            ) : (
              '登录'
            )}
          </button>
        </form>

        <OAuthButtons />

        <div className="flex items-center justify-center gap-2 text-sm text-slate-500">
          <span>还没有账号？</span>
          <Link to="/register" className="font-semibold text-[#8b6f47] hover:text-[#b89968]">
            立即注册
          </Link>
        </div>
      </div>
    </AuthLayout>
  );
}
