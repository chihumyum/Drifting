import { getSessionToken } from './session-token';
let binding: { accountSubject: string; token: string } | null = null;
/** Only a server-verified session can authorize a local library's outbound sync. */
export function bindHostedSession(accountSubject: string, token: string | null): void {
  binding = token ? { accountSubject, token } : null;
}
export function getHostedSessionBinding(): { accountSubject: string; token: string } | null {
  return binding && binding.token === getSessionToken() ? binding : null;
}
export function clearHostedSessionBinding(): void {
  binding = null;
}
