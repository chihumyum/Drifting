import { ComponentProps, ElementType } from "react";
import { GoogleIcon } from "../viewComponents/auth/OAuthIcon";

export const OAUTH_PROVIDERS = ['google'] as const;
export type SupportedOAuthProvider = typeof OAUTH_PROVIDERS[number];

export const OAUTH_PROVIDER_CONFIG: Record<SupportedOAuthProvider, { name: string; Icon: ElementType<ComponentProps<"svg">> }> = {
    google: { name: 'Google', Icon: GoogleIcon },
}