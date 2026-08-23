import type { MobileBackSource } from './mobile-workspace-controller';

export const MOBILE_WORKSPACE_BACK_EVENT = 'drifting:mobile-workspace-back' as const;

export interface MobileWorkspaceBackEventDetail {
  source: MobileBackSource;
}

const preflightEscapes = new WeakSet<KeyboardEvent>();

export function isMobileWorkspaceBackPreflight(event: KeyboardEvent): boolean {
  return preflightEscapes.has(event);
}

/**
 * Let existing DOM-owned dialogs and popovers consume Escape first, then send
 * one typed request to the Mobile V2 owner. This is used by visible Back and
 * Android hardware Back, so both paths share the same layer resolver.
 */
export function requestMobileWorkspaceBack(source: MobileBackSource): boolean {
  const escape = new KeyboardEvent('keydown', {
    key: 'Escape',
    code: 'Escape',
    bubbles: true,
    cancelable: true,
  });
  preflightEscapes.add(escape);
  const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
  const escapeAccepted = target.dispatchEvent(escape);
  if (!escapeAccepted) return true;

  const request = new CustomEvent<MobileWorkspaceBackEventDetail>(MOBILE_WORKSPACE_BACK_EVENT, {
    detail: { source },
    bubbles: false,
    cancelable: true,
  });
  return !window.dispatchEvent(request);
}
