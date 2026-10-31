import { Component, useEffect, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { PreAlphaOnboardingDialog } from './components/modals/PreAlphaOnboardingDialog';
import { AuthDialogHost } from './features/auth/AuthDialog';
import { ShareLinksDialogHost } from './features/share-links/ShareLinksDialogHost';
import loglevel from 'loglevel';
import { AppEffects } from './app/effects/AppEffects';
import { LocationDeepLinkEffects } from './app/effects/LocationDeepLinkEffects';
import { FullScreenStatus } from './app/components/FullScreenStatus';
import { AppRoutes } from './app/AppRoutes';
import { getPlatformRuntime } from './platform/runtime';
import { disableMobileWebViewZoom } from './shells/mobile/mobile-webview-zoom';
import { DatabaseRecoveryBoundary } from './app/components/DatabaseRecoveryBoundary';
import { useDatabaseOpenFailure } from './platform/database-recovery-store';
import { ConfirmationDialog } from './components/modals/ConfirmationDialog';
import { reportError } from './services/diagnostics/crash-reporter';
import { CharSea } from './components/char-sea/CharSea';
import { charSeaEnabled } from './components/char-sea/useCharSea';

const log = loglevel.getLogger('App');

log.setLevel(import.meta.env.DEV ? loglevel.levels.TRACE : loglevel.levels.WARN);

interface RootErrorBoundaryState {
  error: Error | null;
}

class RootErrorBoundary extends Component<{ children: ReactNode }, RootErrorBoundaryState> {
  state: RootErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): RootErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    log.error('[App] Unhandled renderer error:', error, info.componentStack);
    // The whole UI was replaced by the fallback, so this is always fatal.
    reportError('render-failure', error, 'fatal');
  }

  private retry = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return <RootErrorFallback error={this.state.error} onRetry={this.retry} />;
    }
    return this.props.children;
  }
}

function RootErrorFallback({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <FullScreenStatus
      title={t('appShell.unexpectedTitle')}
      detail={`${t('appShell.unexpectedDetail')} ${error.message}`}
      action={{ label: t('appShell.retry'), onClick: onRetry }}
    />
  );
}

function AppContents() {
  const databaseFailure = useDatabaseOpenFailure();
  const [seaEnabled] = useState(charSeaEnabled);
  useEffect(() => {
    if (!getPlatformRuntime().isMobile) return;
    return disableMobileWebViewZoom();
  }, []);

  if (databaseFailure?.recoverySessionId) {
    return <DatabaseRecoveryBoundary failure={databaseFailure} />;
  }

  return (
    <>
      {seaEnabled && <CharSea />}
      <AppEffects />
      <LocationDeepLinkEffects />
      <PreAlphaOnboardingDialog />
      <AppRoutes />
      <AuthDialogHost />
      <ShareLinksDialogHost />
    </>
  );
}

export default function App() {
  return (
    <RootErrorBoundary>
      <>
        <AppContents />
        <ConfirmationDialog />
      </>
    </RootErrorBoundary>
  );
}
