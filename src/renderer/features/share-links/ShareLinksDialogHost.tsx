import { lazy, Suspense } from 'react';
import { hostedAccountSettingsEnabled } from '../settings/hosted-settings-policy';
import { useShareLinksDialogStore } from './share-links-dialog-store';

const ShareLinksDialog = lazy(() => import('./ShareLinksDialog').then(module => ({ default: module.ShareLinksDialog })));

/** Globally mounted list of the account's share links; opened through `useShareLinksDialogStore`. */
export function ShareLinksDialogHost() {
  const open = useShareLinksDialogStore(state => state.open);
  const close = useShareLinksDialogStore(state => state.close);
  if (!open || !hostedAccountSettingsEnabled()) return null;
  return (
    <Suspense fallback={null}>
      <ShareLinksDialog onClose={close} />
    </Suspense>
  );
}
