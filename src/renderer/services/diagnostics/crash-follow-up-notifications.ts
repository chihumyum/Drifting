import { i18next } from '../../lib/i18n';
import { useNotificationStore } from '../../store/notification-store';
import { crashReportsSettled, takeCrashFollowUp, type CrashFollowUp } from './crash-reporter';

export function crashFollowUpNotificationId(followUp: CrashFollowUp): string {
  return `crash-follow-up:${followUp.fingerprint}:${followUp.occurredAt}`;
}

let offered = false;

/**
 * Once this launch's reports have settled, put the newest delivered fatal
 * report from an earlier launch in the notification center, once. Its row
 * opens the feedback dialog as a follow-up (features/feedback).
 */
export async function offerCrashFollowUp(): Promise<void> {
  if (offered) return;
  offered = true;
  await crashReportsSettled();
  const followUp = takeCrashFollowUp();
  if (!followUp) return;
  const occurredAt = Date.parse(followUp.occurredAt);
  useNotificationStore.getState().ingest({
    id: crashFollowUpNotificationId(followUp),
    source: 'crash-follow-up',
    state: 'failed',
    title: i18next.t('feedback.crash.title'),
    crashFollowUp: followUp,
    at: Number.isFinite(occurredAt) ? Math.min(occurredAt, Date.now()) : Date.now(),
  });
}

/** Tests offer again without reloading the module. */
export function resetCrashFollowUpOfferForTests(): void {
  offered = false;
}
