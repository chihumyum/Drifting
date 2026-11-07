import { useEffect, useLayoutEffect } from 'react';
import { useTranslation } from 'react-i18next';
import loglevel from 'loglevel';
import { applyAccentColor, initAccentColor } from '../../lib/theme';
import { useUiStore } from '../../store/ui-store';
import { useSettingsStore } from '../../store/settings-store';
import { setI18nLocale } from '../../lib/i18n';
import { applyEditorPreferences } from '../../lib/editor-preferences';
import { applyInterfaceTextSize } from '../../lib/interface-typography';
import { ensureImportedProseFontLoaded } from '../../lib/prose-fonts';
import { saveActiveEditor } from '../../lib/active-editor';
import { platform } from '../../platform';
import { getPlatformRuntime } from '../../platform/runtime';
import { flushApplicationPersistenceForLifecycle } from '../../lib/persistence-lifecycle';
import { installProductionSyncRuntime } from '../../sync/production-runtime';
import { installHostedSyncGenerationProvisioningRuntime } from '../../sync/provision/hosted-runtime';
import { installHostedDiscoveryRuntime } from '../../sync/hosted/runtime';
import { installProductSyncAuthorityMonitor } from '../../sync/product-authority-store';
import { events } from '../../lib/events';
import { UpdateService } from '../../services/update/update-service';
import { installUpdateNotifications } from '../../services/update/update-notifications';
import { offerCrashFollowUp } from '../../services/diagnostics/crash-follow-up-notifications';
import { runAssetStoreRestartGc } from '../../services/asset-store-restart-gc';
import { installV2HandoffRuntime } from '../../services/v2-handoff/runtime';
import { applyResolvedColorScheme } from '../../lib/initial-theme';
import { reportIntegrityEvent } from '../../services/diagnostics/crash-reporter';
import { APP_CONFIG } from '../../lib/config';

const log = loglevel.getLogger('AppEffects');
log.setLevel(import.meta.env.DEV ? loglevel.levels.TRACE : loglevel.levels.WARN);

function AppearanceEffects() {
  const themeMode = useSettingsStore((state) => state.themeMode);
  const accentColor = useSettingsStore((state) => state.accentColor);
  const interfaceTextSize = useSettingsStore((state) => state.interfaceTextSize);
  const setUiTheme = useUiStore((state) => state.setTheme);

  useLayoutEffect(() => {
    applyInterfaceTextSize(interfaceTextSize);
  }, [interfaceTextSize]);

  useEffect(() => {
    initAccentColor();
  }, []);

  useEffect(() => {
    applyAccentColor(accentColor);
  }, [accentColor]);

  useEffect(() => {
    const root = document.documentElement;
    const apply = (mode: 'light' | 'dark') => {
      applyResolvedColorScheme(root, mode);
      setUiTheme(mode);
    };
    if (themeMode === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      apply(mq.matches ? 'dark' : 'light');
      const handler = (event: MediaQueryListEvent) => apply(event.matches ? 'dark' : 'light');
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
    apply(themeMode);
    return undefined;
  }, [themeMode, setUiTheme]);

  useEffect(() => {
    const runtime = getPlatformRuntime();
    if (!runtime.isMacDesktop || !runtime.desktopWindowControls) return;
    void platform.window
      .setTrafficLightPosition({ x: 18, y: 23 })
      .catch((error) => log.warn('Native window-control positioning is unavailable:', error));
  }, []);

  // Windows keeps its native title bar; it follows Drifting's theme, not the system's.
  const uiTheme = useUiStore((state) => state.theme);
  useEffect(() => {
    const runtime = getPlatformRuntime();
    if (runtime.nativePlatform !== 'windows' || !runtime.desktopWindowControls) return;
    void platform.window
      .setTheme(uiTheme)
      .catch((error) => log.warn('Native title-bar theme is unavailable:', error));
  }, [uiTheme]);

  return null;
}

function EditorPreferenceEffects() {
  const editorFontSource = useSettingsStore((state) => state.editorFontSource);
  const editorSystemFontFamily = useSettingsStore((state) => state.editorSystemFontFamily);
  const setEditorFontSource = useSettingsStore((state) => state.setEditorFontSource);
  const bodyFontSize = useSettingsStore((state) => state.bodyFontSize);
  const editorLineHeight = useSettingsStore((state) => state.lineHeight);
  const maxLineWidth = useSettingsStore((state) => state.maxLineWidth);
  const editorTextWrap = useSettingsStore((state) => state.editorTextWrap);
  const paragraphIndent = useSettingsStore((state) => state.paragraphIndent);
  const editorIndentStep = useSettingsStore((state) => state.editorIndentStep);
  const paragraphSpacing = useSettingsStore((state) => state.paragraphSpacing);
  const caretColor = useSettingsStore((state) => state.caretColor);
  const entityLinkInteractive = useSettingsStore((state) => state.entityLinkInteractive);
  const entityLinkColorMode = useSettingsStore((state) => state.entityLinkColorMode);
  const entityLinkHighlightMode = useSettingsStore((state) => state.entityLinkHighlightMode);
  const entityLinkBandStyle = useSettingsStore((state) => state.entityLinkBandStyle);

  useEffect(() => {
    applyEditorPreferences({
      editorFontSource,
      editorSystemFontFamily,
      bodyFontSize,
      lineHeight: editorLineHeight,
      maxLineWidth,
      editorTextWrap,
      paragraphIndent,
      editorIndentStep,
      paragraphSpacing,
      caretColor,
      entityLinkInteractive,
      entityLinkColorMode,
      entityLinkHighlightMode,
      entityLinkBandStyle,
    });
  }, [
    editorFontSource,
    editorSystemFontFamily,
    bodyFontSize,
    editorLineHeight,
    maxLineWidth,
    editorTextWrap,
    paragraphIndent,
    editorIndentStep,
    paragraphSpacing,
    caretColor,
    entityLinkInteractive,
    entityLinkColorMode,
    entityLinkHighlightMode,
    entityLinkBandStyle,
  ]);

  useEffect(() => {
    if (editorFontSource !== 'imported') return;
    let cancelled = false;
    void ensureImportedProseFontLoaded()
      .then((metadata) => {
        if (
          !cancelled &&
          !metadata &&
          useSettingsStore.getState().editorFontSource === 'imported'
        ) {
          setEditorFontSource('system-serif');
        }
      })
      .catch((error) => log.warn('Imported prose font could not be loaded:', error));
    return () => {
      cancelled = true;
    };
  }, [editorFontSource, setEditorFontSource]);

  return null;
}

function LocaleEffects() {
  const uiLocale = useSettingsStore((state) => state.uiLocale);
  const { t, i18n } = useTranslation();
  useEffect(() => {
    setI18nLocale(uiLocale);
  }, [uiLocale]);
  // Windows keeps Drifting in the notification area; its menu speaks the
  // interface language (src-tauri/src/windows_tray.rs).
  useEffect(() => {
    if (!getPlatformRuntime().isWindowsDesktop) return;
    void platform.window
      .setTrayLabels({ open: t('windowCaption.trayOpen'), quit: t('windowCaption.trayQuit') })
      .catch((error) => log.warn('Tray labels are unavailable:', error));
  }, [t, i18n.language]);
  return null;
}

function PersistenceLifecycleEffects() {
  useEffect(() => {
    const unsubscribe = platform.lifecycle.onFlushBeforeQuit((request) => {
      void flushApplicationPersistenceForLifecycle(request.reason)
        .then(() => {
          if (!request.confirmationRequired || request.requestId == null) return;
          void platform.lifecycle
            .confirmFlushBeforeQuit(request.requestId)
            .catch((error) => log.warn('confirmFlushBeforeQuit failed:', error));
        })
        .catch((error) => {
          log.warn('Lifecycle persistence flush failed:', error);
          reportIntegrityEvent('local-flush-failed', error, { reason: request.reason });
        });
    });

    const onBeforeUnload = () => {
      void saveActiveEditor().catch(() => undefined);
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    return () => {
      unsubscribe();
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, []);

  return null;
}

function SyncEngineEffects() {
  useEffect(() => {
    const stopAuthorityMonitor = installProductSyncAuthorityMonitor();
    const stopHostedProvisioning = installHostedSyncGenerationProvisioningRuntime();
    const stopHostedDiscovery = installHostedDiscoveryRuntime();
    const stopSync = installProductionSyncRuntime();
    // Readers' comments on share links and the account's preferences; only
    // Hosted-configured builds load them.
    let stopShareInbox: (() => void) | undefined;
    let stopPreferenceSync: (() => void) | undefined;
    let disposed = false;
    if (!APP_CONFIG.LOCAL_ONLY_MODE) {
      void import('../../features/share-links/share-inbox-runtime').then((module) => {
        if (!disposed) stopShareInbox = module.installShareInboxRuntime();
      });
      void import('../../features/preference-sync/preference-sync-runtime').then((module) => {
        if (!disposed) stopPreferenceSync = module.installPreferenceSyncRuntime();
      });
    }
    return () => {
      disposed = true;
      stopPreferenceSync?.();
      stopShareInbox?.();
      stopHostedDiscovery();
      stopHostedProvisioning();
      stopSync();
      stopAuthorityMonitor();
    };
  }, []);
  return null;
}

function RestoredProjectUiEffects() {
  useEffect(() => {
    const clearDeviceLocalTabs = ({ projectIds }: { projectIds: string[] }) => {
      for (const projectId of projectIds) {
        useUiStore.getState().clearProjectTabs(projectId);
      }
    };
    events.on('sync:projects-restored', clearDeviceLocalTabs);
    return () => events.off('sync:projects-restored', clearDeviceLocalTabs);
  }, []);
  return null;
}

/**
 * How often an open app asks whether the automatic update check is due. The
 * service itself runs it at most every AUTO_CHECK_INTERVAL_MS (3 hours); the
 * short tick keeps that true across sleep, which pauses timers.
 */
const UPDATE_CHECK_TICK_MS = 10 * 60 * 1_000;

function UpdaterEffects() {
  useEffect(() => {
    let stopNotifications: (() => void) | null = null;
    let tick: number | null = null;
    const check = () => {
      stopNotifications ??= installUpdateNotifications();
      tick ??= window.setInterval(check, UPDATE_CHECK_TICK_MS);
      void UpdateService.check().catch((error) =>
        log.warn('Automatic update check failed:', error),
      );
    };
    events.on('db:ready', check);
    return () => {
      events.off('db:ready', check);
      if (tick !== null) window.clearInterval(tick);
      stopNotifications?.();
    };
  }, []);
  return null;
}

/**
 * Keeps this library ready for the 0.2 import: caches equal to Yjs and a
 * stamp saying so (docs/v2-handoff.md). Installed once, when the library opens.
 */
function V2HandoffEffects() {
  useEffect(() => {
    let stop: (() => void) | null = null;
    const install = () => {
      stop ??= installV2HandoffRuntime();
    };
    events.on('db:ready', install);
    return () => {
      events.off('db:ready', install);
      stop?.();
    };
  }, []);
  return null;
}

/** A fatal report from an earlier launch becomes one notification the author can explain. */
function CrashFollowUpEffects() {
  useEffect(() => {
    if (getPlatformRuntime().isMobileShell) return;
    void offerCrashFollowUp();
  }, []);
  return null;
}

function AssetStoreRestartGcEffects() {
  useEffect(() => {
    const collect = () => {
      void runAssetStoreRestartGc().catch((error) =>
        log.warn('Current-format orphan asset cleanup stopped safely:', error),
      );
    };
    events.on('db:ready', collect);
    return () => events.off('db:ready', collect);
  }, []);
  return null;
}

export function AppEffects() {
  return (
    <>
      <LocaleEffects />
      <AppearanceEffects />
      <EditorPreferenceEffects />
      <PersistenceLifecycleEffects />
      <SyncEngineEffects />
      <RestoredProjectUiEffects />
      <AssetStoreRestartGcEffects />
      <V2HandoffEffects />
      <UpdaterEffects />
      <CrashFollowUpEffects />
    </>
  );
}
