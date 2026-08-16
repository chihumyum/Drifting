import { APP_CONFIG, isAuthRequired } from '../../lib/config';

export const HOSTED_ACCOUNT_SETTING_IDS = ['account', 'subscription'] as const;

const HOSTED_ACCOUNT_SETTING_ID_SET = new Set<string>(HOSTED_ACCOUNT_SETTING_IDS);

/**
 * Account and billing settings belong to an explicitly configured hosted
 * service. Public/local builds use the synthetic local library identity and
 * must not expose or mount those panels.
 */
export function hostedAccountSettingsEnabled(): boolean {
  return !APP_CONFIG.LOCAL_ONLY_MODE && isAuthRequired();
}

export function isHostedAccountSettingId(id: string): boolean {
  return HOSTED_ACCOUNT_SETTING_ID_SET.has(id);
}

export function withoutHostedAccountSettings<T extends { id: string }>(
  items: readonly T[],
  enabled = hostedAccountSettingsEnabled(),
): T[] {
  return enabled ? [...items] : items.filter((item) => !isHostedAccountSettingId(item.id));
}
