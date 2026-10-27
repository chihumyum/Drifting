import { useEffect } from 'react';
import loglevel from 'loglevel';
import type { NavigateFunction } from 'react-router-dom';
import { platform } from '../../../platform';
import { getPlatformRuntime } from '../../../platform/runtime';

const log = loglevel.getLogger('CloseButtonReturnsToShelf');

/**
 * The workspace has no project name or back button: the window's close button
 * closes the project instead. While a project is open the native close request
 * comes back as an event and the workspace returns to the bookshelf; on the
 * shelf the close button closes the window as before.
 */
export function useCloseButtonReturnsToShelf(navigate: NavigateFunction) {
  useEffect(() => {
    if (!getPlatformRuntime().desktopWindowControls) return undefined;
    const setEnabled = (enabled: boolean) => {
      void platform.window
        .setCloseReturnsToShelf(enabled)
        .catch((error) => log.warn('Close-to-shelf is unavailable:', error));
    };
    setEnabled(true);
    const stop = platform.window.onCloseToShelf(() => navigate('/'));
    return () => {
      stop();
      setEnabled(false);
    };
  }, [navigate]);
}
