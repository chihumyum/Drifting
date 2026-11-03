// The steps of the desktop first-run card (PreAlphaFirstRunGate).

/** The first-run card's steps; null once nothing is left to ask. */
export type FirstRunStep = 'welcome' | 'account' | 'folder';

/**
 * Which step the first-run card shows. Local or account use is asked only
 * where there is an account to choose (a Hosted build); then, once per device,
 * where projects' Markdown folders go.
 */
export function firstRunStep(state: {
  guideOpen: boolean;
  folderOpen: boolean;
  hosted: boolean;
  signingIn: boolean;
}): FirstRunStep | null {
  if (state.guideOpen && state.hosted) return state.signingIn ? 'account' : 'welcome';
  if (state.folderOpen) return 'folder';
  return null;
}
