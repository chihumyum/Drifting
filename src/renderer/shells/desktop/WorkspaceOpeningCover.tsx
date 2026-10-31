import { useTranslation } from 'react-i18next';
import { useWorkspaceOpeningCovered } from './useWorkspaceOpening';

/**
 * Over the hidden workspace while it opens (useWorkspaceOpening): takes the
 * pointer, so nothing unseen is clicked (the sea still feels it and rings),
 * and keeps the wait's words for screen readers.
 */
export function WorkspaceOpeningCover() {
  const { t } = useTranslation();
  const opening = useWorkspaceOpeningCovered();
  if (!opening) return null;
  return (
    <div role="status" aria-live="polite" className="workspace-opening-cover">
      <span className="sr-only">{`${t('appShell.loadingProject')} ${t('appShell.readingProject')}`}</span>
    </div>
  );
}
