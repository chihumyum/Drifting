import { APP_CONFIG } from './config';
export interface HostedProfile {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
}
const KEY = 'drifting.hosted.profile.v1';
export function readHostedProfile(): HostedProfile | null {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (
      value?.origin !== APP_CONFIG.API_BASE_URL ||
      typeof value.user?.id !== 'string' ||
      typeof value.user?.email !== 'string' ||
      typeof value.user?.name !== 'string'
    )
      return null;
    return {
      id: value.user.id,
      email: value.user.email,
      name: value.user.name,
      emailVerified: value.user.emailVerified === true,
    };
  } catch {
    return null;
  }
}
/** Offline display/ownership metadata only. Never serialize a session or bearer token. */
export function writeHostedProfile(user: HostedProfile | null): void {
  if (!user) {
    localStorage.removeItem(KEY);
    return;
  }
  localStorage.setItem(
    KEY,
    JSON.stringify({
      origin: APP_CONFIG.API_BASE_URL,
      user: { id: user.id, email: user.email, name: user.name, emailVerified: user.emailVerified },
    }),
  );
}
