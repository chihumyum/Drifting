import { authClient } from "@/renderer/lib/auth-client";
import { OAUTH_PROVIDER_CONFIG, OAUTH_PROVIDERS } from "@/renderer/lib/oauth-providers";

export const OAuthButtons = () => {
    // TODO: handle errors and loading states
    return OAUTH_PROVIDERS.map((provider) => {
        const Icon = OAUTH_PROVIDER_CONFIG[provider].Icon;
        return (
            <button
                key={provider}
                onClick={() => {
                    authClient.signIn.social({provider, callbackURL: '/'});
                }}
                className="flex w-full items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
                <Icon className="h-5 w-5" />
                使用 {OAUTH_PROVIDER_CONFIG[provider].name} 登录
            </button>
        );
    });
};