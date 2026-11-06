import { useEffect, useState } from 'react';
import { AuthDialogHost } from './features/auth/AuthDialog';
import { SignOutDialogHost } from './features/auth/SignOutDialog';
import { ShareLinksDialogHost } from './features/share-links/ShareLinksDialogHost';
import { FeedbackDialogHost } from './features/feedback/FeedbackDialogHost';
import { AppEffects } from './app/effects/AppEffects';
import { LocationDeepLinkEffects } from './app/effects/LocationDeepLinkEffects';
import { NativeOAuthEffects } from './app/effects/NativeOAuthEffects';
import { RenderErrorBoundary } from './app/components/RenderErrorBoundary';
import { AppRoutes } from './app/AppRoutes';
import { getPlatformRuntime } from './platform/runtime';
import { disableMobileWebViewZoom } from './shells/mobile/mobile-webview-zoom';
import { DatabaseRecoveryBoundary } from './app/components/DatabaseRecoveryBoundary';
import { useDatabaseOpenFailure } from './platform/database-recovery-store';
import { ConfirmationDialog } from './components/modals/ConfirmationDialog';
import { CharSea } from './components/char-sea/CharSea';
import { charSeaEnabled } from './components/char-sea/useCharSea';
import { WindowsCaption } from './components/workspaceChrome/WindowsCaption';

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
      <NativeOAuthEffects />
      <AppRoutes />
      <AuthDialogHost />
      <SignOutDialogHost />
      <ShareLinksDialogHost />
      <FeedbackDialogHost />
    </>
  );
}

export default function App() {
  return (
    <RenderErrorBoundary scope="app">
      <>
        <AppContents />
        <ConfirmationDialog />
        <WindowsCaption />
      </>
    </RenderErrorBoundary>
  );
}
