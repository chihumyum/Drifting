import { lazy, Suspense } from 'react';
import { useFeedbackDialogStore } from './feedback-dialog-store';

const FeedbackDialog = lazy(() => import('./FeedbackDialog').then(module => ({ default: module.FeedbackDialog })));

/** Globally mounted feedback dialog; opened through `useFeedbackDialogStore`. */
export function FeedbackDialogHost() {
  const open = useFeedbackDialogStore(state => state.open);
  const followUp = useFeedbackDialogStore(state => state.followUp);
  const close = useFeedbackDialogStore(state => state.close);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <FeedbackDialog key={followUp ? `${followUp.fingerprint}:${followUp.occurredAt}` : 'feedback'}
        followUp={followUp} onClose={close} />
    </Suspense>
  );
}
