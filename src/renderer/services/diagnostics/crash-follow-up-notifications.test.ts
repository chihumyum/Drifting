import { beforeEach, expect, it, vi } from 'vitest';

const followUps = vi.hoisted(() => ({ take: vi.fn() }));
vi.mock('../../lib/i18n', () => ({ i18next: { t: (key: string) => key } }));
vi.mock('./crash-reporter', () => ({
  crashReportsSettled: () => Promise.resolve(),
  takeCrashFollowUp: followUps.take,
}));
import { useNotificationStore } from '../../store/notification-store';
import {
  crashFollowUpNotificationId,
  offerCrashFollowUp,
  resetCrashFollowUpOfferForTests,
} from './crash-follow-up-notifications';

const followUp = {
  kind: 'native-panic' as const, fingerprint: 'native-panic:src-lib.rs:88',
  occurredAt: '2026-10-31T07:59:00.000Z', reportId: 'report-1',
};

beforeEach(() => {
  useNotificationStore.getState().clear();
  followUps.take.mockReset();
  resetCrashFollowUpOfferForTests();
});

it('puts the crash in the notification center once per launch', async () => {
  followUps.take.mockReturnValue(followUp);
  await offerCrashFollowUp();
  await offerCrashFollowUp(); // a retried root boundary remounts its effects
  expect(followUps.take).toHaveBeenCalledOnce();
  const items = useNotificationStore.getState().items;
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    id: crashFollowUpNotificationId(followUp), source: 'crash-follow-up', state: 'failed',
    title: 'feedback.crash.title', crashFollowUp: followUp, read: false,
    updatedAt: Date.parse(followUp.occurredAt),
  });
});

it('adds nothing when there is no crash to explain', async () => {
  followUps.take.mockReturnValue(null);
  await offerCrashFollowUp();
  expect(useNotificationStore.getState().items).toHaveLength(0);
});
