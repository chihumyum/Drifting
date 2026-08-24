import type { MobileBackSource } from './mobile-workspace-controller';

export const MOBILE_WORKSPACE_BACK_EVENT = 'drifting:mobile-workspace-back' as const;

export interface MobileWorkspaceBackEventDetail {
  source: MobileBackSource;
}

export interface MobileWorkspaceBackRequestOptions {
  preflightDom?: boolean;
}

const preflightEscapes = new WeakSet<KeyboardEvent>();

export function isMobileWorkspaceBackPreflight(event: KeyboardEvent): boolean {
  return preflightEscapes.has(event);
}

/**
 * Let existing DOM-owned dialogs and popovers consume Escape first, then send
 * one typed request to the Mobile V2 owner. A level-only control can skip the
 * DOM preflight so ProseMirror never receives a synthetic Escape. Visible Back
 * and Android hardware Back still share the same typed layer resolver.
 */
export function requestMobileWorkspaceBack(
  source: MobileBackSource,
  { preflightDom = true }: MobileWorkspaceBackRequestOptions = {},
): boolean {
  if (preflightDom) {
    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    preflightEscapes.add(escape);
    const target =
      document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
    const escapeAccepted = target.dispatchEvent(escape);
    if (!escapeAccepted) return true;
  }

  const request = new CustomEvent<MobileWorkspaceBackEventDetail>(MOBILE_WORKSPACE_BACK_EVENT, {
    detail: { source },
    bubbles: false,
    cancelable: true,
  });
  return !window.dispatchEvent(request);
}
