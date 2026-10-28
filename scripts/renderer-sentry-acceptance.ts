import { APP_CONFIG } from '../src/renderer/lib/config';
import { setSessionToken } from '../src/renderer/lib/session-token';
import { useSettingsStore } from '../src/renderer/store/settings-store';
import { flushCrashReports, installCrashReporting, reportDiagnosticLog, reportIntegrityEvent } from '../src/renderer/services/diagnostics/crash-reporter';

function syntheticRendererFailure(): never {
  throw new TypeError('synthetic-browser-failure');
}

// Every value is synthetic; the browser profile and HTTPS receiver are isolated.
setSessionToken('synthetic-bearer-must-not-be-sent');
localStorage.setItem('synthetic-private-state', 'synthetic-private-local-storage-marker');
document.cookie = 'synthetic_private_cookie=synthetic-private-cookie-marker; SameSite=Lax';
useSettingsStore.setState({ sendCrashLogs: true });
installCrashReporting();

Object.assign(window, { __SENTRY_BROWSER_ACCEPTANCE__: {
  ready: true,
  crash: () => setTimeout(syntheticRendererFailure, 0),
  rejection: () => { void Promise.reject(new Error('synthetic-browser-rejection')); },
  integrity: (code: string) => reportIntegrityEvent(code),
  log: () => reportDiagnosticLog('update-download-completed', { bytes: 128 }),
  consent: (enabled: boolean) => useSettingsStore.setState({ sendCrashLogs: enabled }),
  queueLength: () => JSON.parse(localStorage.getItem('drifting.diagnostics.queue.v1') ?? '[]').length,
  async flush() {
    await flushCrashReports();
    if (!APP_CONFIG.LOCAL_ONLY_MODE) {
      const { flushSentryLogs } = await import('../src/renderer/services/diagnostics/sentry-reporter');
      await flushSentryLogs();
    }
  },
} });
