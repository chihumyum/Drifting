import { useParams } from 'react-router-dom';
import { ProjectRuntimeProvider } from '../../app/providers/ProjectRuntimeProvider';
import { SuperViewRelationUiProvider } from '../../features/graph/SuperViewRelationUiContext';
import { useAuthStore } from '../../store/auth';
import { MobileDesk } from './desk/MobileDesk';

/**
 * Opening a project mounts `MobileAppShell`: the shared project runtime and,
 * over it, the phone's desk (docs/mobile-ui-foundation.md). Only the active
 * paper mounts a full editor.
 */
export function MobileAppShell() {
  const { projectId } = useParams<{ projectId: string }>();
  const userId = useAuthStore((state) => state.user?.id);
  if (!projectId) throw new Error('Project ID is required in URL');
  if (!userId) throw new Error('User must be authenticated');
  return (
    <ProjectRuntimeProvider projectId={projectId} userId={userId}>
      <SuperViewRelationUiProvider key={projectId} projectId={projectId}>
        <MobileDesk projectId={projectId} />
      </SuperViewRelationUiProvider>
    </ProjectRuntimeProvider>
  );
}
