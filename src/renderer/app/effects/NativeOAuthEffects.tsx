import { useEffect, useLayoutEffect, useRef } from 'react';

import { useOpenSignIn } from '../../features/auth/auth-dialog-store';
import { installNativeOAuth } from '../../features/auth/native-oauth';
import { hostedAccountSettingsEnabled } from '../../features/settings/hosted-settings-policy';

/**
 * Receive `drifting://auth/callback` for the whole app, so a social sign-in
 * that returns after a cold start or a closed dialog still completes.
 */
export function NativeOAuthEffects() {
  const openSignIn = useOpenSignIn();
  const open = useRef(openSignIn);
  useLayoutEffect(() => {
    open.current = openSignIn;
  }, [openSignIn]);
  useEffect(() => {
    if (!hostedAccountSettingsEnabled()) return undefined;
    return installNativeOAuth(() => open.current('signin'));
  }, []);
  return null;
}
