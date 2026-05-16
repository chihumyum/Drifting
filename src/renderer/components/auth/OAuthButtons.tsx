import { useEffect, useState } from 'react';
import {
  OAUTH_PROVIDER_CONFIG,
  OAUTH_PROVIDERS,
  SupportedOAuthProvider,
} from '@/renderer/lib/oauth-providers';
import { useAuthStore } from '@/renderer/store/auth';

export const OAuthButtons = () => {
  const [loading, setLoading] = useState<SupportedOAuthProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const checkSession = useAuthStore((s) => s.checkSession);

  useEffect(() => {
    const cleanup = window.electronAPI.auth.onOAuthCallback(
      async ({ token, error: callbackError }) => {
        setLoading(null);
        if (callbackError || !token) {
          setError('OAuth 登录失败，请重试。');
          return;
        }
        try {
          // Cookie is already set by main process; just sync the session.
          await checkSession();
        } catch {
          setError('无法获取登录状态，请重试。');
        }
      },
    );
    return cleanup;
  }, [checkSession]);

  const handleLogin = async (provider: SupportedOAuthProvider) => {
    setError(null);
    setLoading(provider);
    try {
      await window.electronAPI.auth.openOAuthBrowser(provider);
    } catch {
      setError('无法打开浏览器，请重试。');
      setLoading(null);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {error && <p className="text-sm text-red-500 text-center">{error}</p>}
      {OAUTH_PROVIDERS.map((provider) => {
        const Icon = OAUTH_PROVIDER_CONFIG[provider].Icon;
        const isLoading = loading === provider;
        return (
          <button
            key={provider}
            onClick={() => handleLogin(provider)}
            disabled={isLoading || loading !== null}
            className="flex w-full items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Icon className="h-5 w-5" />
            {isLoading ? '等待浏览器授权...' : `使用 ${OAUTH_PROVIDER_CONFIG[provider].name} 登录`}
          </button>
        );
      })}
    </div>
  );
};
