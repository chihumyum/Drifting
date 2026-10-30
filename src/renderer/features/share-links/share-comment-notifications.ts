import { i18next } from '../../lib/i18n';
import { useNotificationStore } from '../../store/notification-store';
import type { ShareInboxComment } from './share-link-api';

const EXCERPT = 80;

/**
 * One notification per shared entity for the readers' comments an inbox pass
 * brought in: the entity's title, and the reader and comment, or the count.
 * It opens the entity, in whichever project it is.
 */
export function notifyReaderComments(arrived: readonly ShareInboxComment[], titleOf: (shareId: string) => string | null): void {
  const byShare = new Map<string, ShareInboxComment[]>();
  for (const comment of arrived) byShare.set(comment.shareId, [...(byShare.get(comment.shareId) ?? []), comment]);
  const { ingest } = useNotificationStore.getState();
  for (const [shareId, comments] of byShare) {
    const first = comments[0]!;
    const body = first.body.replace(/\s+/g, ' ').trim();
    ingest({
      id: `share-comments:${first.id}`,
      source: 'share-comment',
      state: 'completed',
      title: titleOf(shareId) ?? i18next.t('notifications.shareComments.source'),
      detail: comments.length === 1
        ? i18next.t('notifications.shareComments.single', {
            name: first.authorName,
            body: body.length > EXCERPT ? `${body.slice(0, EXCERPT)}…` : body,
          })
        : i18next.t('notifications.shareComments.count', { count: comments.length }),
      count: comments.length,
      target: { projectId: first.projectId, entityType: first.entityKind, id: first.entityId },
      at: Date.now(),
    });
  }
}
