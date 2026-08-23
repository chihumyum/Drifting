import { useEffect } from 'react';
import loglevel from 'loglevel';
import { applyAccentColor, initAccentColor } from '../../lib/theme';
import { useUiStore } from '../../store/ui-store';
import { useSettingsStore } from '../../store/settings-store';
import { setI18nLocale } from '../../lib/i18n';
import { applyEditorPreferences } from '../../lib/editor-preferences';
import { ensureImportedProseFontLoaded } from '../../lib/prose-fonts';
import { saveActiveEditor } from '../../lib/active-editor';
import { platform } from '../../platform';
import { getPlatformRuntime } from '../../platform/runtime';
import { flushApplicationPersistenceForLifecycle } from '../../lib/persistence-lifecycle';
import { installProductionSyncRuntime } from '../../sync/production-runtime';
import { installGoogleDriveSyncGenerationProvisioningRuntime } from '../../sync/provision';
import { installProductSyncAuthorityMonitor } from '../../sync/product-authority-store';
import { events } from '../../lib/events';
import { UpdateService } from '../../services/update/update-service';
import { runAssetStoreRestartGc } from '../../services/asset-store-restart-gc';
import { applyResolvedColorScheme } from '../../lib/initial-theme';

const log = loglevel.getLogger('AppEffects');
log.setLevel(import.meta.env.DEV ? loglevel.levels.TRACE : loglevel.levels.WARN);

function AppearanceEffects() {
  const themeMode = useSettingsStore((state) => state.themeMode);
  const accentColor = useSettingsStore((state) => state.accentColor);
  const setUiTheme = useUiStore((state) => state.setTheme);

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
      .setTrafficLightPosition({ x: 18, y: 22 })
      .catch((error) => log.warn('Native window-control positioning is unavailable:', error));
  }, []);

  return null;
}

function EditorPreferenceEffects() {
  const editorFontSource = useSettingsStore((state) => state.editorFontSource);
  const editorSystemFontFamily = useSettingsStore((state) => state.editorSystemFontFamily);
  const setEditorFontSource = useSettingsStore((state) => state.setEditorFontSource);
  const bodyFontSize = useSettingsStore((state) => state.bodyFontSize);
  const editorLineHeight = useSettingsStore((state) => state.lineHeight);
  const maxLineWidth = useSettingsStore((state) => state.maxLineWidth);
  const paragraphIndent = useSettingsStore((state) => state.paragraphIndent);
  const editorIndentStep = useSettingsStore((state) => state.editorIndentStep);
  const paragraphSpacing = useSettingsStore((state) => state.paragraphSpacing);
  const caretColor = useSettingsStore((state) => state.caretColor);
  const entityLinkInteractive = useSettingsStore((state) => state.entityLinkInteractive);
  const entityLinkColorMode = useSettingsStore((state) => state.entityLinkColorMode);

  useEffect(() => {
    applyEditorPreferences({
      editorFontSource,
      editorSystemFontFamily,
      bodyFontSize,
      lineHeight: editorLineHeight,
      maxLineWidth,
      paragraphIndent,
      editorIndentStep,
      paragraphSpacing,
      caretColor,
      entityLinkInteractive,
      entityLinkColorMode,
    });
  }, [
    editorFontSource,
    editorSystemFontFamily,
    bodyFontSize,
    editorLineHeight,
    maxLineWidth,
    paragraphIndent,
    editorIndentStep,
    paragraphSpacing,
    caretColor,
    entityLinkInteractive,
    entityLinkColorMode,
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
  useEffect(() => {
    setI18nLocale(uiLocale);
  }, [uiLocale]);
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
        .catch((error) => log.warn('Lifecycle persistence flush failed:', error));
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
    const stopProvisioning = installGoogleDriveSyncGenerationProvisioningRuntime();
    const stopSync = installProductionSyncRuntime();
    return () => {
      stopSync();
      stopProvisioning();
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

function AlphaUpdaterEffects() {
  useEffect(() => {
    const check = () => {
      void UpdateService.check().catch((error) =>
        log.warn('Automatic Alpha update check failed:', error),
      );
    };
    events.on('db:ready', check);
    return () => events.off('db:ready', check);
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
      <AlphaUpdaterEffects />
    </>
  );
}
