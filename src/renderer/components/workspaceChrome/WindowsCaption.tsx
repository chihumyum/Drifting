import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import loglevel from 'loglevel';
import { platform } from '../../platform';
import { getPlatformRuntime } from '../../platform/runtime';
import { BrushIcon } from '../ui/BrushIcon';

const log = loglevel.getLogger('WindowsCaption');

/**
 * Windows has no title bar of its own here (src-tauri/src/windows_webview.rs
 * turns the native one off): its window buttons are one glass pill in the
 * top-left corner, where macOS keeps its traffic lights and in their order —
 * close, minimize, maximize. The pill is the paper toolbar's tray without its
 * fill; the left sidebar toggle stands beside it. Close is the window's own
 * close request, so an open book still returns to the shelf first.
 */
export function WindowsCaption() {
  const { t } = useTranslation();
  const [maximized, setMaximized] = useState(false);
  const shown = getPlatformRuntime().isWindowsDesktop;

  useEffect(() => {
    if (!shown) return undefined;
    let alive = true;
    const sync = () => {
      void platform.window
        .isMaximized()
        .then((value) => {
          if (alive) setMaximized(value);
        })
        .catch((error) => log.warn('Window state is unavailable:', error));
    };
    sync();
    window.addEventListener('resize', sync);
    return () => {
      alive = false;
      window.removeEventListener('resize', sync);
    };
  }, [shown]);

  if (!shown) return null;
  const run = (action: () => Promise<unknown>) => () => {
    void action().catch((error) => log.warn('Window control failed:', error));
  };
  const maximizeLabel = t(maximized ? 'windowCaption.restore' : 'windowCaption.maximize');
  return (
    <div className="windows-caption glass glass--rest" role="group" aria-label={t('windowCaption.label')}>
      <button
        type="button"
        className="windows-caption__button windows-caption__button--close glass glass--round"
        title={t('windowCaption.close')}
        aria-label={t('windowCaption.close')}
        onClick={run(() => platform.window.close())}
      >
        <BrushIcon name="close" />
      </button>
      <button
        type="button"
        className="windows-caption__button glass glass--round"
        title={t('windowCaption.minimize')}
        aria-label={t('windowCaption.minimize')}
        onClick={run(() => platform.window.minimize())}
      >
        <BrushIcon name="minus" />
      </button>
      <button
        type="button"
        className="windows-caption__button glass glass--round"
        title={maximizeLabel}
        aria-label={maximizeLabel}
        onClick={run(async () => setMaximized(await platform.window.toggleMaximize()))}
      >
        <BrushIcon name={maximized ? 'window-restore' : 'window-max'} />
      </button>
    </div>
  );
}
