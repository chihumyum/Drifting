import { useCallback, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getProjectReferenceIndexSnapshot, retryProjectReferenceIndex, subscribeProjectReferenceIndex,
} from '../../services/reference-index.service';

/** Healthy queue progress does not rerender the reference panel. */
export function ReferenceIndexNotice({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const subscribe = useCallback((listener: () => void) => subscribeProjectReferenceIndex(projectId, listener), [projectId]);
  const getError = useCallback(() => getProjectReferenceIndexSnapshot(projectId).hasError, [projectId]);
  const hasError = useSyncExternalStore(subscribe, getError, getError);
  if (!hasError) return null;
  return (
    <div className="refs-index-status" role="status">
      <span>{t('referencesPanel.updateFailed')}</span>
      <button className="refs-section__action" type="button" onClick={() => retryProjectReferenceIndex(projectId)}>
        {t('common.retry')}
      </button>
    </div>
  );
}
